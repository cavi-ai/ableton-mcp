const sameState = (a, b) => a?.stateVersion === b?.stateVersion && a?.setFingerprint === b?.setFingerprint;

// Session revisions are immutable. Publishing the next revision is a cross-process
// compare-and-swap; long-running model requests never hold the Live control queue.
export class ProductionSessions {
  constructor({ artifacts, context, run, apply, verify }) {
    Object.assign(this, { artifacts, context, run, apply, verify });
  }

  summary(record) {
    const { value: s, sessionRef } = record;
    return { sessionId: s.sessionId, sessionRef, revision: s.revision, phase: s.phase,
      goal: s.goal.slice(0, 600), goalTruncated: s.goal.length > 600, scope: s.scope,
      basis: s.basis, contextRef: s.contextRef, targetRef: s.targetRef, selectedRef: s.selectedRef, feedbackRef: s.feedbackRef,
      taskId: s.taskId, receiptId: s.receiptId, operationIndex: s.operationIndex,
      status: s.status, stateChanged: s.stateChanged || false, userDecision: s.userDecision, evaluationRef: s.evaluationRef,
      alternatives: s.alternatives?.map(({ name, description }) => ({ name: name.slice(0, 160), nameTruncated: name.length > 160,
        description: description.slice(0, 300), descriptionTruncated: description.length > 300 })),
      audibleQualityVerified: false };
  }

  async start(args) {
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
      resume: [], propose: [], choose: ["alternativeIndex"],
      apply: ["expectedStateVersion", "dryRun", "confirmationToken", "planHash"],
      feedback: ["text"], evaluate: ["decision"]
    }[action];
    if (Object.keys(args).some(key => !["projectId", "sessionId", "expectedRevision", "action", ...allowed].includes(key)))
      throw new Error("arguments do not match the session action");
    const phase = (...phases) => { if (!phases.includes(s.phase)) throw new Error(`action ${action} is invalid in session phase ${s.phase}`); };
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
    const fresh = async () => {
      const observed = await observe();
      if (!sameState(observed, s.basis) || observed.targetHash !== s.targetHash) throw new Error("session state changed; resume and propose again");
      return observed;
    };
    const restart = observed => ({ ...s, phase: "inspect", taskId: undefined, receiptId: undefined, operationIndex: undefined,
      alternatives: undefined, userDecision: undefined, evaluationRef: undefined, status: "requires_proposal",
      basis: { stateVersion: observed.stateVersion, setFingerprint: observed.setFingerprint }, targetHash: observed.targetHash,
      targetRef: observed.targetRef, contextRef: observed.contextRef });

    if (action === "resume") {
      const observed = await observe();
      const changed = !sameState(observed, s.basis) || observed.targetHash !== s.targetHash;
      const interrupted = ["execution_pending", "proposing", "needs_inspection"].includes(s.phase);
      return save({ ...(changed || interrupted ? restart(observed) : s), contextRef: observed.contextRef,
        stateChanged: changed, status: interrupted ? "interrupted_inspect_before_proposing" : changed ? "requires_proposal" : s.status });
    }
    if (action === "feedback") {
      phase("audition", "evaluate");
      if (!args.text) throw new Error("listening feedback text is required");
      await fresh();
      const feedbackRef = this.artifacts.put(projectId, "feedback", { text: args.text, taskId: s.taskId, receiptId: s.receiptId });
      return save({ ...s, feedbackRef, phase: "evaluate" });
    }
    if (action === "evaluate") {
      phase("evaluate");
      if (!s.feedbackRef || !args.decision) throw new Error("feedback and an explicit decision are required");
      const observed = await fresh();
      if (s.receiptId && this.artifacts.get(projectId, s.receiptId).value.status !== "applied") throw new Error("operation outcome requires inspection");
      if (args.decision === "accept") {
        const task = this.artifacts.get(projectId, s.taskId).value;
        const checks = await this.verify(projectId, task.checks);
        await fresh();
        const evaluationRef = this.artifacts.put(projectId, "evaluation", { taskId: s.taskId, receiptId: s.receiptId,
          feedbackRef: s.feedbackRef, checks, decision: args.decision });
        if (checks.some(check => !check.matches)) return { ...save({ ...s, evaluationRef, status: "postconditions_failed" }), checks };
        return save({ ...s, evaluationRef, phase: "complete", userDecision: "accept", status: "accepted" });
      }
      return save({ ...restart(observed), feedbackRef: s.feedbackRef, userDecision: "revise" });
    }
    if (action === "choose") {
      phase("choose");
      const alternative = s.alternatives?.[args.alternativeIndex];
      if (!alternative) throw new Error("choose an alternativeIndex from the saved proposal");
      await fresh();
      const selectedRef = this.artifacts.put(projectId, "selection", { alternative, creativeTaskId: s.taskId, alternativeIndex: args.alternativeIndex });
      return save({ ...s, phase: "propose", selectedRef, alternatives: undefined, taskId: undefined });
    }
    if (action === "propose") {
      phase("inspect", "propose");
      await fresh();
      const role = s.phase === "inspect" ? "creative" : "functional";
      save({ ...s, phase: "proposing", status: "running" });
      let task;
      try {
        task = await this.run({ projectId, goal: s.goal, scope: s.scope, constraints: s.constraints,
          workflow: s.workflow, postconditions: s.postconditions, roles: role,
          contextRefs: [s.contextRef, s.targetRef, s.selectedRef, s.feedbackRef].filter(Boolean) });
      } catch (error) {
        save({ ...s, phase: role === "creative" ? "inspect" : "propose", status: "proposal_failed" });
        throw error;
      }
      const savedTask = this.artifacts.get(projectId, task.taskId).value;
      const alternatives = savedTask.results.find(item => item.role === "creative")?.result.alternatives;
      const nextPhase = task.status !== "proposed" ? "inspect" : role === "creative" ? (alternatives?.length ? "choose" : "inspect")
        : task.operationCount ? "apply" : "audition";
      return { ...save({ ...s, phase: nextPhase, status: task.status, taskId: task.taskId,
        alternatives, operationIndex: 0, receiptId: undefined }), task };
    }
    phase("apply");
    if (!Number.isInteger(args.expectedStateVersion)) throw new Error("expectedStateVersion is required for apply");
    await fresh();
    const operationArgs = { projectId, taskId: s.taskId, operationIndex: s.operationIndex,
      previousReceiptId: s.receiptId, expectedStateVersion: args.expectedStateVersion,
      dryRun: args.dryRun, confirmationToken: args.confirmationToken, planHash: args.planHash };
    if (args.dryRun !== false) return { ...this.summary(record), operation: await this.apply(operationArgs) };
    save({ ...s, phase: "execution_pending", status: "outcome_unknown" });
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
    const task = this.artifacts.get(projectId, s.taskId).value;
    const applied = operation.status === "applied";
    return { ...save({ ...s, phase: applied ? (s.operationIndex + 1 < task.operations.length ? "apply" : "audition") : "needs_inspection",
      operationIndex: applied ? s.operationIndex + 1 : s.operationIndex, receiptId: operation.receiptId,
      basis: applied ? { stateVersion: observed.stateVersion, setFingerprint: observed.setFingerprint } : s.basis,
      ...(applied ? { targetHash: observed.targetHash, targetRef: observed.targetRef, contextRef: observed.contextRef } : {}),
      status: operation.status }), operation };
  }
}
