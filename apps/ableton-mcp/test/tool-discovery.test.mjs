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

test("every tool advertises MCP annotations matching its mutation class", async () => {
  const listed = await createRouter(new ToolService({}))({ id: 1, method: "tools/list" });
  for (const tool of listed.result.tools) {
    assert.ok(tool.annotations, `missing annotations on ${tool.name}`);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `readOnlyHint on ${tool.name}`);
    assert.equal(typeof tool.annotations.destructiveHint, "boolean", `destructiveHint on ${tool.name}`);
  }
  const byName = new Map(listed.result.tools.map(tool => [tool.name, tool]));
  for (const name of ["get_live_state", "list_scenes", "plan_drum_pattern", "analyze_audio_file",
    "get_track_midi_routing", "capture_track_state_snapshot"]) {
    assert.deepEqual(byName.get(name).annotations, { readOnlyHint: true, destructiveHint: false }, name);
  }
  for (const name of ["set_tempo", "create_track", "launch_clip", "undo",
    "set_scene_launch_quantization", "create_groove", "set_track_midi_routing"]) {
    assert.deepEqual(byName.get(name).annotations, { readOnlyHint: false, destructiveHint: false }, name);
  }
  for (const name of ["delete_clip", "delete_device", "delete_session_object",
    "crop_audio_clip", "set_looper_state", "set_device_parameters"]) {
    assert.deepEqual(byName.get(name).annotations, { readOnlyHint: false, destructiveHint: true }, name);
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
