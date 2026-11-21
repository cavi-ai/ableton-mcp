export const sameState = (a, b) => a?.stateVersion === b?.stateVersion && a?.setFingerprint === b?.setFingerprint;

// A bounded projection of immutable attempts and receipts, not a rollback log.
export const createExecution = (taskId, task, unrecordedPrefix = 0) => ({ taskId,
  operations: task.operations.map((operation, index) => ({ index, tool: operation.tool,
    status: index < unrecordedPrefix ? "unrecorded" : "not_attempted" })) });

export function recordExecution(execution, index, patch) {
  if (!execution || !Number.isInteger(index) || !execution.operations[index]) throw new Error("execution operation is unavailable");
  return { ...execution, operations: execution.operations.map((row, position) => position === index ? { ...row, ...patch } : { ...row }) };
}

export function executionSummary(execution) {
  if (!execution) return undefined;
  const counts = {};
  for (const row of execution.operations) counts[row.status] = (counts[row.status] || 0) + 1;
  return { ...execution, operations: execution.operations.map(row => ({ ...row })), counts };
}

export const executionStarted = execution => Boolean(execution?.operations.some(row => row.status !== "not_attempted"));

// Task summaries and model-selected checks cannot establish that a requested
// change is unnecessary. Only fresh caller-owned criteria can establish a no-op.
export async function assessTaskCompletion({ intent, functional, postconditions, verify }) {
  if (!functional) return { status: "proposed" };
  if (intent === "inspect") return { status: "observed" };
  if (functional.operations.length) return { status: "proposed" };
  if (!postconditions?.length) return { status: "incomplete", stopReason: "missing_operations" };
  try {
    const checks = await verify(postconditions);
    return checks.length === postconditions.length && checks.every(check => check.matches)
      ? { status: "no_change_needed", checks }
      : { status: "incomplete", stopReason: "postconditions_unmet", checks };
  } catch (error) {
    return { status: "incomplete", stopReason: "postconditions_unavailable", error: error.message };
  }
}

// Budget, Live identity and open questions outrank any completion evidence.
export function taskStatus({ exhausted, stale, questions = [], completion = {} }) {
  if (exhausted) return { status: "budget_exhausted" };
  if (stale) return { status: "stale_context" };
  if (questions.length) return { status: "needs_input" };
  return completion.status === "incomplete" ? { status: "incomplete", stopReason: completion.stopReason } : { status: completion.status };
}

export function receiptStatus({ error, observationError, operationOutcome, checks = [] }) {
  if (error) return error.outcome === "not_executed" ? "rejected" : "outcome_unknown";
  if (observationError) return "outcome_unknown";
  if (operationOutcome.status !== "applied") return operationOutcome.status;
  return checks.some(check => !check.matches) ? "postconditions_failed" : "applied";
}

const finishedOperationsPhase = checkedCompletion => checkedCompletion ? "evaluate" : "audition";

export function phaseAfterTask({ status, operationCount, role, alternatives, checkedCompletion }) {
  if (!["proposed", "no_change_needed"].includes(status)) return "inspect";
  if (role === "creative") return alternatives?.length ? "choose" : "inspect";
  return operationCount ? "apply" : finishedOperationsPhase(checkedCompletion);
}

export const pendingExecution = (execution, index, attemptRef) => ({ phase: "execution_pending", status: "outcome_unknown",
  execution: recordExecution(execution, index, { status: "execution_pending", attemptRef }) });

// An operation is applied only when its receipt says so and Live still matches that receipt.
const failureText = value => {
  const message = typeof value === "string" ? value : value?.message;
  return message || (value == null ? "" : String(value)) || "failed";
};

export function operationTransition({ execution, index, operationCount, checkedCompletion, operation, error, observationError }) {
  const outcome = error ? { status: "outcome_unknown", error: failureText(error) }
    : observationError !== undefined ? { ...operation, status: "outcome_unknown", observationError: failureText(observationError) } : operation;
  const applied = outcome.status === "applied";
  return { operation: outcome, applied, status: outcome.status,
    phase: applied ? (index + 1 < operationCount ? "apply" : finishedOperationsPhase(checkedCompletion)) : "needs_inspection",
    execution: recordExecution(execution, index, { status: outcome.status,
      ...(outcome.receiptId ? { receiptId: outcome.receiptId } : {}),
      ...(outcome.resultRef ? { resultRef: outcome.resultRef } : {}),
      ...(outcome.operationOutcome ? { nativeStatus: outcome.operationOutcome.status } : {}),
      ...(outcome.error || outcome.observationError ? { error: String(outcome.error || outcome.observationError).slice(0, 300) } : {}) }) };
}

// A pending attempt never resolves to success on resume; its outcome stays unknown.
export function resumeRecovery({ phase, changed, execution, operationIndex }) {
  if (!["execution_pending", "needs_inspection"].includes(phase) && !(changed && phase === "apply" && executionStarted(execution))) return null;
  return { phase: "needs_inspection", status: "requires_recovery",
    execution: phase === "execution_pending" && execution ? recordExecution(execution, operationIndex, { status: "outcome_unknown" }) : execution };
}

export function evaluationOutcome({ checks, checkedCompletion }) {
  if (checks.some(check => !check.matches)) return { phase: "evaluate", status: "postconditions_failed" };
  return { phase: "complete", status: checkedCompletion ? "postconditions_met" : "accepted" };
}
