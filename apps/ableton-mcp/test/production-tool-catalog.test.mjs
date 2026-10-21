import test from "node:test";
import assert from "node:assert/strict";
import { toolContracts } from "../src/tool-contracts.mjs";
import { producerToolContracts } from "../src/producer-contracts.mjs";
import { discoverProductionTools, productionSchemas, eligibleOperation } from "../src/production-tool-catalog.mjs";
import { operationSchema } from "../src/production-tool-catalog.mjs";
import Ajv from "ajv";

test("every specialist capability remains discoverable by its exact name", () => {
  for (const [name, contract] of Object.entries(toolContracts)) {
    if (Object.hasOwn(producerToolContracts, name)) continue;
    const kind = contract.annotations.readOnlyHint ? "read" : eligibleOperation(name) ? "operation" : null;
    if (kind) assert.deepEqual(discoverProductionTools({ query: name, kind }, "functional").names, [name]);
  }
  assert.throws(() => discoverProductionTools({ query: "set_tempo", kind: "operation" }, "creative"), /creative/);
});

test("deferred discovery seeds relevant complete schemas without execution authority", () => {
  const before = JSON.stringify(toolContracts);
  for (const [goal, expected] of [["Set track volume to -12 dB", "set_track_volume_db"],
    ["Set tempo to 100 BPM", "set_tempo"], ["Change device parameter values", "set_device_parameters"]]) {
    const tools = productionSchemas({ role: "functional", deferred: true, goal });
    assert.ok(tools.operations.some(tool => tool.name === expected), `${goal}: ${tools.operations.map(tool => tool.name)}`);
    for (const tool of tools.operations) for (const key of ["dryRun", "confirmationToken", "planHash", "expectedStateVersion"])
      assert.equal(tool.inputSchema.properties[key], undefined);
    assert.ok(tools.available.operations.includes(expected));
    assert.ok(tools.operations.length <= 2); assert.ok(tools.reads.length <= 5);
  }
  assert.equal(JSON.stringify(toolContracts), before);
});

test("read-only intent and creative roles never seed or advertise operations", () => {
  for (const options of [{ role: "creative" }, { role: "functional", intent: "inspect" }]) {
    const tools = productionSchemas({ ...options, deferred: true, goal: "Set tempo to 100" });
    assert.deepEqual(tools.operations, []); assert.deepEqual(tools.available.operations, []);
  }
});

test("search pages are deterministic and bounded without broadening permissions", () => {
  const args = { query: "MIDI notes", kind: "read" };
  const first = discoverProductionTools(args, "functional");
  assert.ok(first.names.length <= 4); assert.deepEqual(discoverProductionTools(args, "functional"), first);
  if (first.nextOffset !== null) {
    const second = discoverProductionTools({ ...args, offset: first.nextOffset }, "functional");
    assert.ok(second.names.every(name => !first.names.includes(name)));
  }
  assert.throws(() => discoverProductionTools({ ...args, offset: -1 }, "functional"), /invalid/);
});

test("proposal schemas strip conditional execution fields while preserving business constraints", () => {
  const ajv = new Ajv({ strict: true });
  const validate = ajv.compile(operationSchema("open_live_set").inputSchema);
  assert.equal(validate({ path: "/scratch.als", expectedSetFingerprint: "set-a" }), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ path: "/scratch.als" }), false);
  assert.equal(validate({ path: "/scratch.als", expectedStateVersion: 1, expectedSetFingerprint: "set-a" }), false);
  const choices = ajv.compile(operationSchema("set_selected_parameter").inputSchema);
  assert.equal(choices({ value: 0.5, targetDisplay: "50%" }), false);
});

test("every discoverable operation schema compiles after execution fields are removed", () => {
  const ajv = new Ajv({ strict: true });
  for (const name of Object.keys(toolContracts).filter(eligibleOperation)) assert.doesNotThrow(() => ajv.compile(operationSchema(name).inputSchema), name);
});
