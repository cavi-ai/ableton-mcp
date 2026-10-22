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
