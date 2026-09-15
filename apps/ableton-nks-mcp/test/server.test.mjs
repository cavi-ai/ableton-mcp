import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRouter } from "../src/server.mjs";

test("server can be imported from a Node eval without starting stdio", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    'const { createRouter } = await import("./src/server.mjs"); const route = createRouter({ call: async () => ({}) }); console.log(JSON.stringify(await route({ id: 1, method: "tools/list" })));'
  ], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).result.tools.some(tool => tool.name === "get_live_state"), true);
});

test("MCP rejects malformed tool arguments before service dispatch", async () => {
  let dispatches = 0;
  const route = createRouter({ call: async () => { dispatches++; return { accepted: true }; } });
  for (const argumentsValue of [null, [], "bad", { trackId: "track-0" },
    { expectedStateVersion: 1, trackId: "track-0", armed: "yes" },
    { expectedStateVersion: 1, trackId: "track-0", armed: true, extra: true }]) {
    const reply = await route({ id: 1, method: "tools/call", params: { name: "arm_track", arguments: argumentsValue } });
    assert.equal(reply.error?.code, -32602);
  }
  assert.equal(dispatches, 0);
  const accepted = await route({ id: 2, method: "tools/call", params: {
    name: "arm_track", arguments: { expectedStateVersion: 1, trackId: "track-0", armed: true }
  } });
  assert.equal(accepted.result.structuredContent.accepted, true);
  assert.equal(dispatches, 1);
});

test("MCP exposes and validates nested MIDI repeat counts", async () => {
  const route = createRouter({ call: async (_name, args) => ({ repeats: args.operation.repeats }) });
  const listed = await route({ id: 1, method: "tools/list" });
  const tool = listed.result.tools.find(({ name }) => name === "transform_midi_notes");
  assert.equal(tool.inputSchema.properties.operation.properties.repeats?.maximum, 16);
  const args = { expectedStateVersion: 1, trackId: "track-0", clipId: "track-0:clip-0", noteIds: [7],
    operation: { type: "duplicate", offsetBeats: 1, repeats: 2 } };
  const accepted = await route({ id: 2, method: "tools/call", params: { name: tool.name, arguments: args } });
  assert.equal(accepted.result.structuredContent.repeats, 2);
  for (const repeats of [0, 17, 1.5, "2"]) {
    const reply = await route({ id: 3, method: "tools/call", params: { name: tool.name,
      arguments: { ...args, operation: { ...args.operation, repeats } } } });
    assert.equal(reply.error?.code, -32602);
  }
});

test("stdio server initializes and lists MCP resources and tools", async () => {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ABLETON_NKS_MCP_FIXTURE: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_presets", arguments: { productSlug: "serum-2", query: "Deep" } } }
    ,{ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "ableton://live/status" } }
  ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  await once(child, "exit");
  const messages = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].result.serverInfo.name, "ableton-mcp");
  assert.equal(messages[1].result.resources.length, 17);
  assert.equal(
    messages[1].result.resources.some(({ uri }) => uri === "nks://catalog/artwork/{artwork_id}"),
    true
  );
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_device_parameters"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "create_midi_clip"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_clip_parameter_envelope"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_clip_parameter_envelope"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_midi_clip_notes"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_midi_clip_notes_extended"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_midi_note_properties"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "transform_midi_notes"), true);
  const transform = messages[2].result.tools.find((tool) => tool.name === "transform_midi_notes");
  assert.equal(transform.inputSchema.properties.operation.type, "object");
  assert.deepEqual(transform.inputSchema.properties.operation.properties.target.enum, ["start", "end", "both"]);
  for (const tool of messages[2].result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown arguments`);
    assert.doesNotMatch(tool.description, /^Ableton NKS operation:/, `${tool.name} needs an actionable description`);
  }
  for (const name of ["set_song_musical_context", "set_clip_timing", "set_device_parameters", "create_midi_clip", "set_clip_parameter_envelope", "set_midi_note_properties", "panic", "transport_play", "transport_stop", "set_tempo", "set_track_mixer", "launch_scene", "launch_clip", "stop_clip", "arm_track"]) {
    const tool = messages[2].result.tools.find((candidate) => candidate.name === name);
    assert.equal(tool.inputSchema.required.includes("expectedStateVersion"), true, `${name} must advertise its state guard`);
  }
  for (const name of ["komplete_open_instrument", "komplete_load_source_preset", "komplete_save_nks_preset", "komplete_run_conversion_batch", "komplete_pause_batch"]) {
    const tool = messages[2].result.tools.find((candidate) => candidate.name === name);
    assert.equal(tool.inputSchema.required.includes("expectedSessionVersion"), true, `${name} must advertise its session guard`);
  }
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_audio_clip_state"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_audio_clip_state"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_history_state"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "undo"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "redo"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_automation_capabilities"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_track_mixer"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_track_routing"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_track_routing"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_group_fold_state"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "route_tracks_to_bus"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_set_mixer"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "list_producer_chain_blueprints"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_producer_chain_blueprint"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_master_mixer"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_return_mixer"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "list_factory_device_profiles"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_factory_device_context"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_factory_browser_items"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "load_factory_browser_item"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_browser_items"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "load_browser_item"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "search_browser_items"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_preset_metadata"), true);
  const metadataMutation = messages[2].result.tools.find((tool) => tool.name === "set_preset_metadata");
  assert.equal(metadataMutation.inputSchema.required.includes("expectedMetadataRevision"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_device_active"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "delete_device"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_device_hierarchy"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_song_musical_context"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_song_musical_context"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_transport_recording_context"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_transport_recording_context"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "list_arrangement_cue_points"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "create_arrangement_cue_point"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "delete_arrangement_cue_point"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_clip_timing"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_clip_timing"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "create_track"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "create_scene"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "rename_session_object"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "duplicate_session_object"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "delete_session_object"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "get_transport_context"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_transport_context"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "duplicate_clip"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "delete_clip"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "duplicate_clip_loop"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "list_tracks"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "list_devices"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "komplete_run_conversion_batch"), true);
  assert.equal(messages[3].result.content[0].type, "text");
  assert.equal(JSON.parse(messages[4].result.contents[0].text).method, "get_live_state");
  assert.match(stderr, /fixture mode/);
  assert.equal(stdout.includes("fixture mode"), false);
});
