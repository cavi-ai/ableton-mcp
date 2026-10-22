import { createExecution, recordExecution, executionSummary, executionStarted } from "./production-execution.mjs";

const sameState = (a, b) => a?.stateVersion === b?.stateVersion && a?.setFingerprint === b?.setFingerprint;
const completedPhases = new Set(["audition", "evaluate", "complete"]);

// Session revisions are immutable. Publishing the next revision is a cross-process
// compare-and-swap; long-running model requests never hold the Live control queue.
export class ProductionSessions {
  constructor({ artifacts, context, run, apply, verify }) {
    Object.assign(this, { artifacts, context, run, apply, verify });
  }

  #execution(s) {
    if (s.execution || !s.taskId) return s.execution;
    const task = this.artifacts.get(s.projectId, s.taskId);
    if (task.kind !== "task") throw new Error("session task reference is invalid");
    let execution = createExecution(s.taskId, task.value, s.operationIndex || 0);
    if (s.receiptId) {
      const record = this.artifacts.get(s.projectId, s.receiptId), receipt = record.value;
      if (record.kind === "receipt" && receipt.taskId === s.taskId && execution.operations[receipt.operationIndex])
        execution = recordExecution(execution, receipt.operationIndex, { status: receipt.status, receiptId: s.receiptId,
          ...(receipt.resultRef ? { resultRef: receipt.resultRef } : {}) });
    }
    return execution;
  }

  summary(record) {
    const { value: s, sessionRef } = record;
    return { sessionId: s.sessionId, sessionRef, revision: s.revision, phase: s.phase,
      goal: s.goal.slice(0, 600), goalTruncated: s.goal.length > 600, scope: s.scope,
      roles: s.roles || "both", completion: s.completion || "listening",
      basis: s.basis, contextRef: s.contextRef, targetRef: s.targetRef, selectedRef: s.selectedRef, feedbackRef: s.feedbackRef,
      taskId: s.taskId, receiptId: s.receiptId, operationIndex: s.operationIndex,
      execution: executionSummary(this.#execution(s)), recoveryRef: s.recoveryRef, recoveryRequired: s.phase === "needs_inspection",
      status: s.status, stateChanged: s.stateChanged || false, userDecision: s.userDecision, evaluationRef: s.evaluationRef,
      alternatives: s.alternatives?.map(({ name, description }) => ({ name: name.slice(0, 160), nameTruncated: name.length > 160,
        description: description.slice(0, 300), descriptionTruncated: description.length > 300 })),
      audibleQualityVerified: false };
  }

  async start(args) {
    if (args.completion === "postconditions" && !args.postconditions?.length)
      throw new Error("postcondition completion requires nonempty caller postconditions");
    const observed = await this.context(args.projectId, args.scope);
    return this.summary(this.artifacts.createSession(args.projectId, { ...args, scope: args.scope || {},
      phase: "inspect", basis: { stateVersion: observed.stateVersion, setFingerprint: observed.setFingerprint },
      documentPath: observed.documentPath, targetHash: observed.targetHash, targetRef: observed.targetRef, contextRef: observed.contextRef }));
  }

  get({ projectId, sessionId, offset }) {
    return sessionId ? this.summary(this.artifacts.session(projectId, sessionId)) : this.artifacts.sessions(projectId, offset);
  }

  async advance(args) {
    const { projectId, sessionId, expectedRevision, action } = args;
    let record = this.artifacts.session(projectId, sessionId);
    let s = record.value;
    if (s.revision !== expectedRevision) throw new Error("session revision conflict; read the current session");
    const allowed = {
      resume: [], replan: ["text", "constraints"], propose: [], choose: ["alternativeIndex"],
      apply: ["expectedStateVersion", "dryRun", "confirmationToken", "planHash"],
      feedback: ["text"], evaluate: ["decision"]
    }[action];
    if (Object.keys(args).some(key => !["projectId", "sessionId", "expectedRevision", "action", ...allowed].includes(key)))
      throw new Error("arguments do not match the session action");
    const phase = (...phases) => { if (!phases.includes(s.phase)) throw new Error(`action ${action} is invalid in session phase ${s.phase}`); };
    const checkedCompletion = s.completion === "postconditions";
    const finishedOperationsPhase = checkedCompletion ? "evaluate" : "audition";
    const save = value => {
      record = this.artifacts.advanceSession(projectId, sessionId, s.revision, value);
      s = record.value;
      return this.summary(record);
    };
    const observe = async () => {
      const observed = await this.context(projectId, s.scope);
      if (observed.documentPath !== s.documentPath) throw new Error("session Set identity does not match Live; open the original Set or start another session");
      return observed;
    };
    const canRetainCompletedWork = observed => completedPhases.has(s.phase) && observed.stateVersion > s.basis.stateVersion &&
      observed.setFingerprint === s.basis.setFingerprint && observed.targetHash === s.targetHash;
    const withObservation = observed => ({ ...s,
      basis: { stateVersion: observed.stateVersion, setFingerprint: observed.setFingerprint },
      contextRef: observed.contextRef, targetRef: observed.targetRef, targetHash: observed.targetHash });
    const fresh = async (retainCompletedWork = false) => {
      const observed = await observe();
      if (!sameState(observed, s.basis) || observed.targetHash !== s.targetHash) {
        if (!retainCompletedWork || !canRetainCompletedWork(observed)) throw new Error("session state changed; resume and inspect before continuing");
        s = { ...withObservation(observed), stateChanged: true };
      }
      return observed;
    };
    const restart = observed => ({ ...s, phase: "inspect", taskId: undefined, receiptId: undefined, operationIndex: undefined, execution: undefined,
      alternatives: undefined, userDecision: undefined, evaluationRef: undefined, status: "requires_proposal",
      basis: { stateVersion: observed.stateVersion, setFingerprint: observed.setFingerprint }, targetHash: observed.targetHash,
      targetRef: observed.targetRef, contextRef: observed.contextRef });

    if (action === "resume") {
      const observed = await observe();
      s = { ...s, execution: this.#execution(s) };
      const changed = !sameState(observed, s.basis) || observed.targetHash !== s.targetHash;
      if (["execution_pending", "needs_inspection"].includes(s.phase) || changed && s.phase === "apply" && executionStarted(s.execution)) {
        const execution = s.phase === "execution_pending" && s.execution
          ? recordExecution(s.execution, s.operationIndex, { status: "outcome_unknown" }) : s.execution;
        return save({ ...withObservation(observed), execution, phase: "needs_inspection", stateChanged: changed, status: "requires_recovery" });
      }
      const interrupted = ["execution_pending", "proposing", "needs_inspection"].includes(s.phase);
      const retained = changed && canRetainCompletedWork(observed);
      const reevaluate = s.phase === "complete" && (!changed || retained);
      return save({ ...(retained ? withObservation(observed) : changed || interrupted ? restart(observed) : s), contextRef: observed.contextRef,
        ...(reevaluate ? { phase: "evaluate", evaluationRef: undefined, userDecision: undefined } : {}),
        stateChanged: changed, status: interrupted ? "interrupted_inspect_before_proposing" : changed && !retained ? "requires_proposal"
          : reevaluate ? "requires_evaluation" : s.status });
    }
    if (action === "replan") {
      const unexecutedRecovery = s.recoveryRef && ["inspect", "propose", "apply"].includes(s.phase) && !executionStarted(this.#execution(s));
      if (!unexecutedRecovery) phase("needs_inspection");
      const observed = await fresh();
      const recoveryRef = this.artifacts.put(projectId, "production-recovery", { taskId: s.taskId,
        receiptId: s.receiptId, execution: s.execution, previousRecoveryRef: s.recoveryRef,
        contextRef: observed.contextRef, targetRef: observed.targetRef, basis: observed,
        previousGoal: s.goal, previousConstraints: s.constraints || [],
        instruction: "Inspect current observations and prior execution. Propose only work still required; do not replay earlier operations or assume rollback." });
      return save({ ...restart(observed), recoveryRef, goal: args.text ?? s.goal, constraints: args.constraints ?? s.constraints });
    }
    if (action === "feedback") {
      phase("audition", "evaluate");
      if (!args.text) throw new Error("listening feedback text is required");
      await fresh(true);
      const feedbackRef = this.artifacts.put(projectId, "feedback", { text: args.text, taskId: s.taskId, receiptId: s.receiptId });
      return save({ ...s, feedbackRef, phase: "evaluate" });
    }
    if (action === "evaluate") {
      phase("evaluate");
      if ((!checkedCompletion && !s.feedbackRef) || !args.decision) throw new Error("feedback and an explicit decision are required");
      const observed = await fresh(true);
      if (s.receiptId && this.artifacts.get(projectId, s.receiptId).value.status !== "applied") throw new Error("operation outcome requires inspection");
      if (args.decision === "accept") {
        const task = this.artifacts.get(projectId, s.taskId).value;
        const checks = await this.verify(projectId, checkedCompletion ? s.postconditions : task.checks);
        await fresh();
        const evaluationRef = this.artifacts.put(projectId, "evaluation", { taskId: s.taskId, receiptId: s.receiptId,
          feedbackRef: s.feedbackRef, checks, decision: args.decision, basis: checkedCompletion ? "postconditions" : "listening" });
        if (checks.some(check => !check.matches)) return { ...save({ ...s, evaluationRef, status: "postconditions_failed" }), checks };
        return save({ ...s, evaluationRef, phase: "complete", userDecision: checkedCompletion ? undefined : "accept",
          status: checkedCompletion ? "postconditions_met" : "accepted" });
      }
      return save({ ...restart(observed), feedbackRef: s.feedbackRef, userDecision: checkedCompletion ? undefined : "revise" });
    }
    if (action === "choose") {
      phase("choose");
      const alternative = s.alternatives?.[args.alternativeIndex];
      if (!alternative) throw new Error("choose an alternativeIndex from the saved proposal");
      await fresh();
      const selectedRef = this.artifacts.put(projectId, "selection", { alternative, creativeTaskId: s.taskId, alternativeIndex: args.alternativeIndex });
      return save({ ...s, phase: "propose", selectedRef, alternatives: undefined, taskId: undefined, execution: undefined });
    }
    if (action === "propose") {
      phase("inspect", "propose");
      await fresh();
      const role = s.phase === "inspect" && s.roles !== "functional" ? "creative" : "functional";
      save({ ...s, phase: "proposing", status: "running" });
      let task;
      try {
        task = await this.run({ projectId, goal: s.goal, scope: s.scope, constraints: s.constraints,
          workflow: s.workflow, postconditions: s.postconditions, roles: role,
          contextRefs: [s.contextRef, s.targetRef, s.selectedRef, s.feedbackRef, s.recoveryRef].filter(Boolean) });
      } catch (error) {
        save({ ...s, phase: role === "creative" ? "inspect" : "propose", status: "proposal_failed" });
        throw error;
      }
      const savedTask = this.artifacts.get(projectId, task.taskId).value;
      const alternatives = savedTask.results.find(item => item.role === "creative")?.result.alternatives;
      const nextPhase = !["proposed", "no_change_needed"].includes(task.status) ? "inspect" : role === "creative" ? (alternatives?.length ? "choose" : "inspect")
        : task.operationCount ? "apply" : finishedOperationsPhase;
      return { ...save({ ...s, phase: nextPhase, status: task.status, taskId: task.taskId,
        alternatives, operationIndex: 0, receiptId: undefined, execution: createExecution(task.taskId, savedTask) }), task };
    }
    phase("apply");
    if (!Number.isInteger(args.expectedStateVersion)) throw new Error("expectedStateVersion is required for apply");
    await fresh();
    const operationArgs = { projectId, taskId: s.taskId, operationIndex: s.operationIndex,
      previousReceiptId: s.receiptId, expectedStateVersion: args.expectedStateVersion,
      dryRun: args.dryRun, confirmationToken: args.confirmationToken, planHash: args.planHash };
    if (args.dryRun !== false) return { ...this.summary(record), operation: await this.apply(operationArgs) };
    const task = this.artifacts.get(projectId, s.taskId).value;
    const attemptRef = this.artifacts.put(projectId, "operation-attempt", { taskId: s.taskId, operationIndex: s.operationIndex,
      tool: task.operations[s.operationIndex].tool, expectedStateVersion: args.expectedStateVersion, planHash: args.planHash,
      startedAt: new Date().toISOString() });
    const execution = this.#execution(s);
    save({ ...s, phase: "execution_pending", status: "outcome_unknown",
      execution: recordExecution(execution, s.operationIndex, { status: "execution_pending", attemptRef }) });
    let operation;
    try { operation = await this.apply(operationArgs); }
    catch (error) { operation = { status: "outcome_unknown", error: error.message }; }
    let observed;
    if (operation.status === "applied") {
      try {
        observed = await observe();
        if (!sameState(observed, operation)) throw new Error("Live changed after the operation receipt; resume before continuing");
      }
      catch (error) { operation = { ...operation, status: "outcome_unknown", observationError: error.message }; }
    }
    const applied = operation.status === "applied";
    const recordedExecution = recordExecution(s.execution, s.operationIndex, { status: operation.status,
      ...(operation.receiptId ? { receiptId: operation.receiptId } : {}),
      ...(operation.resultRef ? { resultRef: operation.resultRef } : {}),
      ...(operation.operationOutcome ? { nativeStatus: operation.operationOutcome.status } : {}),
      ...(operation.error || operation.observationError ? { error: String(operation.error || operation.observationError).slice(0, 300) } : {}) });
    return { ...save({ ...s, phase: applied ? (s.operationIndex + 1 < task.operations.length ? "apply" : finishedOperationsPhase) : "needs_inspection",
      execution: recordedExecution,
      operationIndex: applied ? s.operationIndex + 1 : s.operationIndex, receiptId: operation.receiptId,
      basis: applied ? { stateVersion: observed.stateVersion, setFingerprint: observed.setFingerprint } : s.basis,
      ...(applied ? { targetHash: observed.targetHash, targetRef: observed.targetRef, contextRef: observed.contextRef } : {}),
      status: operation.status }), operation };
  }
}
