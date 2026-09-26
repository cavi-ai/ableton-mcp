import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";

test("MCP discovery exposes every contracted producer tool", async () => {
  const listed = await createRouter(new ToolService({}))({ id: 1, method: "tools/list" });
  const tools = listed.result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(toolContracts).sort());
  for (const name of ["create_rack_chain", "move_device_to_chain"]) {
    assert.equal(tools.find(tool => tool.name === name).inputSchema.additionalProperties, false);
  }
  const metadata = tools.find(tool => tool.name === "set_browser_item_metadata");
  assert.deepEqual(metadata.inputSchema.required, ["expectedMetadataRevision", "root", "path"]);
  assert.match(metadata.description, /private|native/i);
});

test("core discovery is bounded and cannot call tools it does not advertise", async () => {
  let calls = 0;
  const route = createRouter({ call: async () => { calls++; return { ok: true }; } }, { toolProfile: "core" });
  const tools = (await route({ id: 1, method: "tools/list" })).result.tools;
  assert.equal(tools.length, 55);
  const names = new Set(tools.map((tool) => tool.name));
  assert.ok(names.has("get_live_state"));
  assert.ok(names.has("set_tempo"));
  assert.ok(!names.has("apply_midi_diatonic_chord_quality"));
  assert.ok(tools.every((tool) => toolContracts[tool.name]));
  assert.ok(tools.reduce((bytes, tool) => bytes + Buffer.byteLength(JSON.stringify(tool)), 0) / 4 < 20000);
  const hidden = await route({ id: 2, method: "tools/call", params: {
    name: "apply_midi_diatonic_chord_quality", arguments: {}
  } });
  assert.equal(hidden.error.code, -32601);
  assert.equal(calls, 0);
  const visible = await route({ id: 3, method: "tools/call", params: { name: "list_tracks", arguments: {} } });
  assert.equal(visible.result.structuredContent.ok, true);
  assert.equal(calls, 1);
  assert.throws(() => createRouter({}, { toolProfile: "unknown" }), /unknown tool profile/);
});

test("every tool advertises MCP annotations matching its mutation class", async () => {
  const listed = await createRouter(new ToolService({}))({ id: 1, method: "tools/list" });
  for (const tool of listed.result.tools) {
    assert.ok(tool.annotations, `missing annotations on ${tool.name}`);
    assert.deepEqual(Object.keys(tool.annotations).sort(),
      ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].sort(), tool.name);
    for (const hint of Object.keys(tool.annotations)) {
      assert.equal(typeof tool.annotations[hint], "boolean", `${hint} on ${tool.name}`);
    }
    assert.equal(tool.annotations.idempotentHint, tool.annotations.readOnlyHint, tool.name);
  }
  const byName = new Map(listed.result.tools.map(tool => [tool.name, tool]));
  for (const name of ["get_live_state", "list_scenes", "plan_drum_pattern", "analyze_audio_file",
    "get_track_midi_routing", "capture_track_state_snapshot"]) {
    assert.equal(byName.get(name).annotations.readOnlyHint, true, name);
    assert.equal(byName.get(name).annotations.destructiveHint, false, name);
  }
  for (const name of ["set_tempo", "create_track", "launch_clip", "undo",
    "set_scene_launch_quantization", "create_groove", "set_track_midi_routing"]) {
    assert.equal(byName.get(name).annotations.readOnlyHint, false, name);
    assert.equal(byName.get(name).annotations.destructiveHint, false, name);
  }
  for (const name of ["delete_clip", "delete_device", "delete_session_object",
    "crop_audio_clip", "set_looper_state", "set_device_parameters"]) {
    assert.equal(byName.get(name).annotations.readOnlyHint, false, name);
    assert.equal(byName.get(name).annotations.destructiveHint, true, name);
  }
  for (const name of ["delete_arrangement_cue_point", "remove_audio_warp_marker"]) {
    assert.equal(byName.get(name).annotations.destructiveHint, true, name);
  }
  for (const name of ["get_live_scale_reference", "list_live_scales", "list_factory_device_profiles"]) {
    assert.equal(byName.get(name).annotations.openWorldHint, false, name);
  }
  for (const name of ["get_live_state", "search_presets", "set_tempo", "analyze_audio_file"]) {
    assert.equal(byName.get(name).annotations.openWorldHint, true, name);
  }
});

test("every contracted tool has a service handler", async () => {
  const bridge = { request: async () => { throw new Error("bridge unavailable"); } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined } });
  const unhandled = [];
  for (const name of Object.keys(toolContracts)) {
    try {
      await service.call(name, {});
    } catch (error) {
      if (error.message === `unknown tool ${name}`) unhandled.push(name);
    }
  }
  assert.deepEqual(unhandled, []);
});

test("search_presets advertises only the filters the catalog applies", () => {
  assert.deepEqual(Object.keys(toolContracts.search_presets.inputSchema.properties).sort(),
    ["favorite", "limit", "productSlug", "query", "tags"]);
});
