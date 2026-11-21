import test from "node:test";
import assert from "node:assert/strict";
import { assessTaskCompletion, createExecution, evaluationOutcome, operationTransition, pendingExecution, phaseAfterTask,
  receiptStatus, recordExecution, resumeRecovery, sameState, taskStatus } from "../src/production-task-outcome.mjs";

const task = { operations: [{ tool: "set_tempo" }, { tool: "set_tempo" }] };
const unmet = [{ matches: true }, { matches: false }];
const flow = { operationCount: 0, role: "functional", checkedCompletion: true };

test("stale Live identity outranks matching checks for the task and its session", async () => {
  assert.equal(sameState({ stateVersion: 2, setFingerprint: "a" }, { stateVersion: 3, setFingerprint: "a" }), false);
  const completion = await assessTaskCompletion({ intent: "change", functional: { operations: [] },
    postconditions: [{}], verify: async () => [{ matches: true }] });
  assert.equal(completion.status, "no_change_needed");
  const { status } = taskStatus({ stale: true, completion });
  assert.equal(status, "stale_context");
  assert.equal(phaseAfterTask({ ...flow, status }), "inspect");
  assert.equal(phaseAfterTask({ ...flow, status: taskStatus({ completion }).status }), "evaluate");
  const started = recordExecution(createExecution("task", task), 0, { status: "applied" });
  assert.deepEqual(resumeRecovery({ phase: "apply", changed: true, execution: started, operationIndex: 1 }),
    { phase: "needs_inspection", status: "requires_recovery", execution: started });
  assert.equal(resumeRecovery({ phase: "apply", changed: true, execution: createExecution("task", task), operationIndex: 0 }), null);
});

test("unmet checks stop the task, fail the receipt and hold evaluation", async () => {
  const completion = await assessTaskCompletion({ intent: "change", functional: { operations: [] },
    postconditions: [{}, {}], verify: async () => unmet });
  assert.deepEqual(taskStatus({ completion }), { status: "incomplete", stopReason: "postconditions_unmet" });
  assert.equal(phaseAfterTask({ ...flow, status: "incomplete" }), "inspect");
  const status = receiptStatus({ operationOutcome: { status: "applied" }, checks: unmet });
  assert.equal(status, "postconditions_failed");
  const next = operationTransition({ execution: createExecution("task", task), index: 1, operationCount: 2, checkedCompletion: true,
    operation: { status, receiptId: "receipt" } });
  assert.equal(next.phase, "needs_inspection"); assert.equal(next.applied, false);
  assert.deepEqual(next.execution.operations[1], { index: 1, tool: "set_tempo", status: "postconditions_failed", receiptId: "receipt" });
  assert.deepEqual(evaluationOutcome({ checks: unmet, checkedCompletion: true }), { phase: "evaluate", status: "postconditions_failed" });
  assert.deepEqual(evaluationOutcome({ checks: [{ matches: true }], checkedCompletion: true }), { phase: "complete", status: "postconditions_met" });
  assert.deepEqual(evaluationOutcome({ checks: [], checkedCompletion: false }), { phase: "complete", status: "accepted" });
});

test("a lost write stays unknown in its receipt, ledger and resumed session", () => {
  assert.equal(receiptStatus({ error: { outcome: "unknown" } }), "outcome_unknown");
  assert.equal(receiptStatus({ error: { outcome: "not_executed" } }), "rejected");
  assert.equal(receiptStatus({ observationError: "lost", operationOutcome: { status: "applied" } }), "outcome_unknown");
  const pending = pendingExecution(createExecution("task", task), 1, "attempt");
  assert.equal(pending.phase, "execution_pending"); assert.equal(pending.status, "outcome_unknown");
  assert.equal(pending.execution.operations[1].status, "execution_pending");
  const resumed = resumeRecovery({ phase: pending.phase, changed: false, execution: pending.execution, operationIndex: 1 });
  assert.equal(resumed.phase, "needs_inspection"); assert.equal(resumed.status, "requires_recovery");
  assert.deepEqual(resumed.execution.operations[1], { index: 1, tool: "set_tempo", status: "outcome_unknown", attemptRef: "attempt" });
  for (const facts of [{ error: new Error("connection lost") }, { operation: { status: "applied", receiptId: "r" }, observationError: "Live changed" }]) {
    const next = operationTransition({ execution: pending.execution, index: 1, operationCount: 2, checkedCompletion: true, ...facts });
    assert.equal(next.status, "outcome_unknown"); assert.equal(next.phase, "needs_inspection"); assert.equal(next.applied, false);
    assert.equal(next.execution.operations[1].status, "outcome_unknown");
  }
});

test("applied operations advance through the ledger to the completion phase", () => {
  const execution = createExecution("task", task);
  const first = operationTransition({ execution, index: 0, operationCount: 2, checkedCompletion: false,
    operation: { status: "applied", receiptId: "r0", operationOutcome: { status: "applied" } } });
  assert.equal(first.phase, "apply"); assert.equal(first.execution.operations[0].nativeStatus, "applied");
  assert.equal(operationTransition({ execution: first.execution, index: 1, operationCount: 2, checkedCompletion: false,
    operation: { status: "applied" } }).phase, "audition");
  assert.equal(phaseAfterTask({ status: "proposed", operationCount: 0, role: "creative", alternatives: [{}] }), "choose");
  assert.equal(phaseAfterTask({ status: "proposed", operationCount: 2, role: "functional" }), "apply");
});
