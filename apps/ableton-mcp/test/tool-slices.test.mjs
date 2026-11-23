import test from "node:test";
import assert from "node:assert/strict";
import { toolContracts } from "../src/tool-contracts.mjs";
import { producerToolContracts } from "../src/producer-contracts.mjs";
import { createRouter, sessionLogLine } from "../src/server.mjs";
import { listPrompts } from "../src/prompts.mjs";
import { listSliceCatalog, sessionSelection, toolSlices, sliceResourceUris, workflowToolName } from "../src/tool-slices.mjs";
import { runCli } from "../src/cli.mjs";
import { ToolService } from "../src/tool-service.mjs";

const stockRoles = {
  arrange: ["observe", "arrangement", "transport"],
  harmony: ["observe", "voicing"],
  drums: ["observe", "drums", "transport"],
  mix: ["observe", "mixer", "routing"],
  sound: ["observe", "devices", "racks"],
  record: ["observe", "recording", "transport"],
  files: ["observe", "files"]
};

test("every functional tool is in exactly one slice and producer tools are in none", () => {
  const assigned = new Map();
  for (const [slice, names] of Object.entries(toolSlices)) {
    assert.deepEqual(sliceResourceUris[slice] instanceof Array, true, slice);
    for (const name of names) {
      assert.equal(assigned.has(name), false, `${name} is also in ${assigned.get(name)}`);
      assigned.set(name, slice);
    }
  }
  const functional = Object.keys(toolContracts).filter((name) => !Object.hasOwn(producerToolContracts, name) && name !== workflowToolName);
  assert.deepEqual(functional.filter((name) => !assigned.has(name)), []);
  assert.deepEqual([...assigned.keys()].filter((name) => !functional.includes(name)), []);
  assert.equal(assigned.has(workflowToolName), false);
  for (const name of Object.keys(producerToolContracts)) assert.equal(assigned.has(name), false, name);
  const resources = Object.values(sliceResourceUris).flat();
  assert.equal(new Set(resources).size, resources.length);
});

test("a slice session advertises only its union and refuses hidden tools, prompts, and resources", async () => {
  let calls = 0;
  const route = createRouter({
    call: async () => { calls += 1; return { stateVersion: 1, tracks: [], ok: true }; },
    readResource: async (uri) => ({ uri })
  }, { toolSlices: ["observe", "drums"] });
  const listed = await route({ id: 1, method: "tools/list" });
  const names = new Set(listed.result.tools.map((tool) => tool.name));
  assert.equal(names.has("get_live_state"), true);
  assert.equal(names.has("plan_drum_pattern"), true);
  assert.equal(names.has("set_tempo"), false);
  assert.equal(names.has("run_production_task"), false);
  assert.equal(names.has(workflowToolName), false);
  const hidden = await route({ id: 2, method: "tools/call", params: { name: "set_tempo", arguments: {} } });
  assert.equal(hidden.error.code, -32601);
  assert.equal(calls, 0);
  const visible = await route({ id: 3, method: "tools/call", params: { name: "list_tracks", arguments: {} } });
  assert.equal(visible.result.structuredContent.ok, true);
  assert.equal(calls, 1);
  const prompts = await route({ id: 4, method: "prompts/list" });
  assert.deepEqual(prompts.result.prompts, []);
  const prompt = await route({ id: 5, method: "prompts/get", params: { name: "harmonize-clip", arguments: {} } });
  assert.equal(prompt.error.code, -32602);
  const resources = await route({ id: 6, method: "resources/list" });
  assert.ok(resources.result.resources.some((resource) => resource.uri === "ableton://set/tracks"));
  assert.equal(resources.result.resources.some((resource) => resource.uri === "ableton://set/mixer"), false);
  const denied = await route({ id: 7, method: "resources/read", params: { uri: "ableton://set/mixer" } });
  assert.equal(denied.error.code, -32601);
  const notes = await route({ id: 8, method: "resources/read", params: { uri: "ableton://track/track-0/clips" } });
  assert.equal(notes.result.contents[0].uri, "ableton://track/track-0/clips");
  assert.match(sessionLogLine({ toolSlices: ["observe"] }), /^ableton-mcp session slices=observe tools=12 baseSchemaBytes=\d+\n$/);
});

test("stock role unions stay inside the core discovery budget", async () => {
  for (const [role, slices] of Object.entries(stockRoles)) {
    const route = createRouter({ call: async () => ({}) }, { toolSlices: slices });
    const tools = (await route({ id: 1, method: "tools/list" })).result.tools;
    const bytes = Buffer.byteLength(JSON.stringify(tools));
    assert.ok(tools.length <= 63, `${role} advertises ${tools.length} tools`);
    assert.ok(bytes <= 57000, `${role} catalog is ${bytes} bytes`);
    assert.equal(tools.some((tool) => Object.hasOwn(producerToolContracts, tool.name)), false, role);
  }
});

test("unknown, duplicate, and mixed session selectors fail before routing", () => {
  assert.throws(() => createRouter({}, { toolSlices: ["nope"] }), /unknown tool slice: nope/);
  assert.throws(() => createRouter({}, { toolSlices: ["observe", "observe"] }), /duplicate tool slice/);
  assert.throws(() => createRouter({}, { toolProfile: "all", toolSlices: ["observe"] }), /mutually exclusive/);
  assert.throws(() => sessionSelection({ ABLETON_MCP_TOOL_PROFILE: "all", ABLETON_MCP_TOOL_SLICES: "observe" }), /mutually exclusive/);
  assert.throws(() => sessionSelection({ ABLETON_MCP_TOOL_SLICES: "" }), /at least one slice/);
  assert.deepEqual(sessionSelection({}), { toolSlices: ["observe"] });
  assert.deepEqual(sessionSelection({ ABLETON_MCP_TOOL_PROFILE: "producer" }), { toolProfile: "producer" });
});

test("legacy profiles still advertise their catalogs and workflow prompts", async () => {
  const all = createRouter({ call: async () => ({}) });
  const tools = (await all({ id: 1, method: "tools/list" })).result.tools;
  assert.equal(tools.length, Object.keys(toolContracts).length);
  const prompts = await all({ id: 2, method: "prompts/list" });
  assert.equal(prompts.result.prompts.length, listPrompts().length);
  const baseSchemaBytes = Buffer.byteLength(JSON.stringify(tools));
  assert.equal(sessionLogLine({}), `ableton-mcp session profile=all tools=${tools.length} baseSchemaBytes=${baseSchemaBytes}\n`);
});

test("slices command lists the catalog and CLI call ignores it", async () => {
  const catalog = await runCli(["slices"], { stdout() {} });
  assert.deepEqual(catalog.slices.map((slice) => slice.name), listSliceCatalog().map((slice) => slice.name));
  assert.equal(catalog.slices.find((slice) => slice.name === "observe").toolCount, 12);
  let tempo = 120;
  const service = new ToolService({ catalog: {}, bridge: { request: async (method, args) => {
    if (method === "get_live_state") return { stateVersion: 1, tempo };
    if (method === "set_tempo") { tempo = args.tempo; return { stateVersion: 2, tempo }; }
    throw new Error(method);
  } } });
  const dry = await runCli(["call", "set_tempo", "--args", JSON.stringify({ expectedStateVersion: 1, tempo: 90 })], {
    env: { ABLETON_MCP_TOOL_SLICES: "observe" }, runtimeFactory: () => ({ service, close() {} }), stdout() {}
  });
  assert.equal(dry.dryRun, true);
  assert.equal(tempo, 120);
});
