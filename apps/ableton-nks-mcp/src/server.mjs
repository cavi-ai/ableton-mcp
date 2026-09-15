import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { ToolService } from "./tool-service.mjs";
import { createConfiguredService } from "./runtime.mjs";
import { toolContracts } from "./tool-contracts.mjs";
import { validateToolArguments } from "./tool-validation.mjs";

const resources = [
  "nks://catalog/products",
  "nks://catalog/presets/{preset_id}",
  "nks://catalog/artwork/{artwork_id}",
  "ableton://live/status",
  "ableton://live/transport",
  "ableton://set/musical-context",
  "ableton://set/mixer",
  "ableton://set/history",
  "ableton://set/tracks",
  "ableton://track/{track_id}/routing",
  "ableton://set/scenes",
  "ableton://track/{track_id}/clips",
  "ableton://track/{track_id}/clip/{clip_id}/timing",
  "ableton://track/{track_id}/clip/{clip_id}/audio",
  "ableton://track/{track_id}/devices",
  "ableton://device/{device_id}/parameters",
  "komplete://automation/status"
].map((uri) => ({ uri, name: uri }));

const toolNames = [
  "search_presets",
  "get_preset",
  "get_preset_metadata",
  "set_preset_metadata",
  "get_live_state",
  "get_transport_context",
  "set_transport_context",
  "get_history_state",
  "undo",
  "redo",
  "get_song_musical_context",
  "get_clip_groove_context",
  "inspect_clip_groove_postconditions",
  "set_song_musical_context",
  "set_groove",
  "get_transport_recording_context",
  "set_transport_recording_context",
  "list_arrangement_cue_points",
  "create_arrangement_cue_point",
  "rename_arrangement_cue_point",
  "delete_arrangement_cue_point",
  "jump_to_arrangement_cue_point",
  "list_tracks",
  "list_scenes",
  "list_clips",
  "get_midi_clip_notes",
  "get_midi_clip_notes_extended",
  "get_clip_timing",
  "set_clip_timing",
  "create_track",
  "create_return_track",
  "create_scene",
  "rename_session_object",
  "duplicate_session_object",
  "delete_session_object",
  "get_audio_clip_state",
  "get_device_sidechain_routing",
  "set_device_sidechain_routing",
  "analyze_audio_file",
  "analyze_audio_clip",
  "set_audio_clip_state",
  "move_audio_warp_marker",
  "remove_audio_warp_marker",
  "add_audio_warp_marker",
  "quantize_audio_clip",
  "crop_audio_clip",
  "duplicate_clip",
  "delete_clip",
  "duplicate_clip_loop",
  "get_automation_capabilities",
  "get_track_mixer",
  "get_track_routing",
  "set_track_routing",
  "set_group_fold_state",
  "route_tracks_to_bus",
  "get_set_mixer",
  "list_producer_chain_blueprints",
  "get_producer_chain_blueprint",
  "set_master_mixer",
  "move_device",
  "list_arrangement_clips",
  "place_session_clip_in_arrangement",
  "delete_arrangement_clip",
  "move_arrangement_clip",
  "duplicate_arrangement_clip",
  "create_audio_clip",
  "set_return_mixer",
  "list_factory_device_profiles",
  "get_factory_coverage",
  "get_factory_device_context",
  "get_factory_browser_items",
  "load_factory_browser_item",
  "get_browser_items",
  "load_browser_item",
  "search_browser_items",
  "set_device_active",
  "delete_device",
  "get_device_hierarchy",
  "create_rack_chain",
  "set_rack_chain_mixer",
  "rename_rack_chain",
  "set_drum_pad_state",
  "set_rack_chain_note_routing",
  "move_device_to_chain",
  "get_clip_parameter_envelope",
  "list_devices",
  "list_device_parameters",
  "capture_device_parameter_snapshot",
  "capture_device_chain_snapshot",
  "recall_device_chain_snapshot",
  "capture_track_state_snapshot",
  "recall_track_state_snapshot",
  "recall_device_parameter_snapshot",
  "set_device_parameters",
  "create_midi_clip",
  "set_clip_parameter_envelope",
  "set_midi_note_properties",
  "transform_midi_notes",
  "panic",
  "transport_play",
  "transport_stop",
  "set_tempo",
  "set_track_mixer",
  "launch_scene",
  "launch_clip",
  "stop_clip",
  "arm_track",
  "komplete_get_status",
  "komplete_open_instrument",
  "komplete_load_source_preset",
  "komplete_save_nks_preset",
  "komplete_verify_nks_preset",
  "komplete_run_conversion_batch",
  "komplete_pause_batch"
];
const tools = toolNames.map((name) => ({ name, ...toolContracts[name] }));

function fixtureService() {
  const catalog = { search: ({ query }) => [{ id: "serum-2:fixture", name: query || "Deep" }] };
  const bridge = { request: async (method) => ({ method, stateVersion: 1, setFingerprint: "fixture" }) };
  return new ToolService({ bridge, catalog });
}

export function createRouter(service) {
  return async function route(request) {
    const { id, method, params = {} } = request;
    try {
      let result;
      if (method === "initialize") {
        result = {
          protocolVersion: params.protocolVersion || "2025-03-26",
          capabilities: { resources: {}, tools: {} },
          serverInfo: { name: "ableton-mcp", version: "0.1.0" }
        };
      } else if (method === "resources/list") result = { resources };
      else if (method === "resources/read") {
        const value = await service.readResource(params.uri);
        result = { contents: [{ uri: params.uri, text: JSON.stringify(value), mimeType: "application/json" }] };
      }
      else if (method === "tools/list") result = { tools };
      else if (method === "tools/call") {
        const args = params.arguments === undefined ? {} : params.arguments;
        validateToolArguments(params.name, args);
        const value = await service.call(params.name, args);
        result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      } else throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: error.code || -32603, message: error.message } };
    }
  };
}

export async function runStdio({ service }) {
  const route = createRouter(service);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`); continue; }
    process.stdout.write(`${JSON.stringify(await route(request))}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.ABLETON_NKS_MCP_FIXTURE === "1") {
    process.stderr.write("ableton-mcp fixture mode\n");
    await runStdio({ service: fixtureService() });
  } else {
    try {
      const runtime = createConfiguredService(process.env);
      process.stderr.write("ableton-mcp configured runtime\n");
      await runStdio({ service: runtime.service });
      runtime.close();
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
  }
}
