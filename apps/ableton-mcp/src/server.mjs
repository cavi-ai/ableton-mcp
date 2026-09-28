import { createInterface } from "node:readline";
import { ToolService } from "./tool-service.mjs";
import { PACKAGE_VERSION, isMainModule } from "./paths.mjs";
import { createConfiguredService } from "./runtime.mjs";
import { toolContracts } from "./tool-contracts.mjs";
import { validateToolArguments } from "./tool-validation.mjs";
import { getPrompt, listPrompts } from "./prompts.mjs";

const SUPPORTED_PROTOCOL_VERSION = "2025-03-26";

const resourceUris = [
  "nks://catalog/products",
  "nks://catalog/presets/{preset_id}",
  "nks://catalog/artwork/{artwork_id}",
  "ableton://live/status",
  "ableton://live/transport",
  "ableton://live/history",
  "ableton://set/musical-context",
  "ableton://set/mixer",
  "ableton://set/history",
  "ableton://set/tracks",
  "ableton://set/scenes",
  "ableton://track/{track_id}/mixer",
  "ableton://track/{track_id}/routing",
  "ableton://track/{track_id}/midi-routing",
  "ableton://track/{track_id}/freeze",
  "ableton://track/{track_id}/clips",
  "ableton://track/{track_id}/arrangement-clips",
  "ableton://track/{track_id}/clip/{clip_id}/timing",
  "ableton://track/{track_id}/clip/{clip_id}/audio",
  "ableton://track/{track_id}/clip/{clip_id}/notes",
  "ableton://track/{track_id}/devices",
  "ableton://device/{device_id}/parameters"
];
const resources = resourceUris.filter((uri) => !uri.includes("{"))
  .map((uri) => ({ uri, name: uri, mimeType: "application/json" }));
const resourceTemplates = resourceUris.filter((uri) => uri.includes("{"))
  .map((uriTemplate) => ({ uriTemplate, name: uriTemplate, mimeType: "application/json" }));

const toolNames = [
  "search_presets",
  "get_nks_generation_status",
  "get_nks_generation_job",
  "enqueue_nks_generation_jobs",
  "claim_nks_generation_job",
  "heartbeat_nks_generation_job",
  "fail_nks_generation_job",
  "complete_nks_generation_job",
  "get_preset",
  "get_preset_metadata",
  "set_preset_metadata",
  "get_browser_item_metadata",
  "set_browser_item_metadata",
  "search_browser_item_metadata",
  "get_live_state",
  "get_transport_context",
  "set_transport_context",
  "get_history_state",
  "undo",
  "redo",
  "get_song_musical_context",
  "get_live_scale_reference",
  "list_live_scales",
  "get_song_grid_reference",
  "plan_grid_envelope_pattern",
  "plan_drum_pattern",
  "plan_drum_pattern_edit",
  "plan_drum_variation",
  "get_clip_groove_context",
  "analyze_midi_feel",
  "list_saved_snapshots",
  "save_midi_feel_template",
  "load_midi_feel_template",
  "apply_midi_feel_template",
  "inspect_clip_groove_postconditions",
  "set_song_musical_context",
  "set_groove",
  "get_transport_recording_context",
  "capture_midi_session",
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
  "analyze_midi_clip_scale",
  "analyze_midi_clip_chords",
  "plan_scale_chord_progression",
  "plan_scale_bassline",
  "plan_scale_melody",
  "plan_midi_humanization",
  "plan_midi_velocity_curve",
  "plan_midi_gate_pattern",
  "plan_midi_probability_pattern",
  "plan_midi_ratchet_pattern",
  "plan_midi_strum_pattern",
  "plan_midi_chord_inversion",
  "plan_midi_drop_voicing",
  "plan_midi_chord_voice_leading",
  "plan_midi_chord_doubling",
  "plan_midi_chord_arpeggiation",
  "plan_midi_transposition",
  "plan_midi_diatonic_transposition",
  "plan_midi_diatonic_harmony",
  "plan_midi_scale_chord_remapping",
  "plan_midi_diatonic_chord_quality",
  "get_clip_timing",
  "set_clip_timing",
  "create_track",
  "create_return_track",
  "create_scene",
  "rename_session_object",
  "duplicate_session_object",
  "delete_session_object",
  "get_audio_clip_state",
  "get_audio_source_beat_times",
  "propose_audio_transient_warp",
  "get_device_sidechain_routing",
  "set_device_sidechain_routing",
  "analyze_audio_file",
  "analyze_audio_clip",
  "set_audio_clip_state",
  "apply_monophonic_audio_tuning",
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
  "route_tracks_to_return_bus",
  "get_set_mixer",
  "list_producer_chain_blueprints",
  "get_producer_chain_blueprint",
  "inspect_producer_chain",
  "inspect_producer_bus",
  "inspect_producer_return_bus",
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
  "get_plugin_integration_context",
  "get_looper_performance_context",
  "get_beat_repeat_performance_context",
  "get_factory_browser_items",
  "load_factory_browser_item",
  "list_browser_roots",
  "get_browser_items",
  "load_browser_item",
  "search_browser_items",
  "search_browser_roots",
  "list_local_splice_roots",
  "browse_local_splice_directory",
  "search_local_splice_samples",
  "set_device_active",
  "delete_device",
  "get_device_hierarchy",
  "create_rack_chain",
  "adjust_rack_macro_count",
  "map_rack_macro_to_parameter",
  "set_rack_macro_mapping_edge",
  "rename_rack_macro",
  "store_rack_macro_variation",
  "recall_rack_macro_variation",
  "delete_rack_macro_variation",
  "randomize_rack_macros",
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
  "save_device_chain_snapshot",
  "load_device_chain_snapshot",
  "recall_device_chain_snapshot",
  "capture_track_state_snapshot",
  "capture_group_system_snapshot",
  "save_group_system_snapshot",
  "load_group_system_snapshot",
  "save_track_state_snapshot",
  "load_track_state_snapshot",
  "recall_track_state_snapshot",
  "recall_device_parameter_snapshot",
  "set_device_parameters",
  "set_looper_state",
  "set_beat_repeat_enabled",
  "set_beat_repeat_grid",
  "set_beat_repeat_interval",
  "create_midi_clip",
  "create_scale_chord_progression_clip",
  "create_scale_bassline_clip",
  "create_scale_melody_clip",
  "create_drum_pattern_clip",
  "edit_drum_pattern_clip",
  "apply_drum_variation",
  "humanize_midi_notes",
  "apply_midi_velocity_curve",
  "apply_midi_gate_pattern",
  "apply_midi_probability_pattern",
  "apply_midi_ratchet_pattern",
  "apply_midi_strum_pattern",
  "apply_midi_chord_inversion",
  "apply_midi_drop_voicing",
  "apply_midi_chord_voice_leading",
  "apply_midi_chord_doubling",
  "apply_midi_chord_arpeggiation",
  "apply_midi_transposition",
  "apply_midi_diatonic_transposition",
  "apply_midi_diatonic_harmony",
  "apply_midi_scale_chord_remapping",
  "apply_midi_diatonic_chord_quality",
  "set_clip_parameter_envelope",
  "set_midi_note_properties",
  "correct_midi_clip_to_scale",
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
  "set_scene_launch_quantization",
  "set_scene_musical_context",
  "create_groove",
  "get_track_midi_routing",
  "set_track_midi_routing",
  "get_track_freeze_state",
  "set_track_freeze_state",
  "set_bulk_track_mixer",
  "stop_all_clips"
];
// A smaller first-session surface for hosts with a tight tool-context budget.
// The full catalog remains the default and every handler keeps its contract.
const coreToolNames = new Set([
  "search_presets", "get_preset", "get_preset_metadata",
  "get_live_state", "get_transport_context", "get_song_musical_context",
  "get_song_grid_reference", "get_transport_recording_context",
  "get_live_scale_reference", "list_live_scales",
  "list_tracks", "list_scenes", "list_clips", "list_arrangement_clips",
  "get_midi_clip_notes_extended", "get_clip_timing", "get_audio_clip_state",
  "get_track_mixer", "get_track_routing", "get_set_mixer",
  "route_tracks_to_return_bus",
  "list_producer_chain_blueprints", "get_producer_chain_blueprint",
  "list_browser_roots", "get_browser_items", "search_browser_items", "search_browser_roots", "load_browser_item",
  "list_local_splice_roots", "browse_local_splice_directory",
  "list_devices", "list_device_parameters", "get_device_hierarchy",
  "get_factory_device_context", "get_plugin_integration_context",
  "analyze_audio_file", "analyze_audio_clip",
  "create_track", "create_scene", "create_midi_clip", "create_audio_clip",
  "set_midi_note_properties", "set_clip_timing", "set_audio_clip_state",
  "set_device_parameters", "set_device_active", "set_track_mixer",
  "set_track_routing", "set_tempo", "set_song_musical_context",
  "transport_play", "transport_stop", "launch_scene", "launch_clip",
  "stop_clip", "stop_all_clips", "arm_track", "panic", "undo", "redo"
]);

function listedTools(profile) {
  if (profile !== "all" && profile !== "core") throw new Error(`unknown tool profile: ${profile}`);
  return toolNames.filter((name) => profile === "all" || coreToolNames.has(name))
    .map((name) => ({ name, ...toolContracts[name] }));
}

function fixtureService() {
  const catalog = { search: ({ query }) => [{ id: "serum-2:fixture", name: query || "Deep" }] };
  const bridge = { request: async (method) => ({ method, stateVersion: 1, setFingerprint: "fixture" }) };
  return new ToolService({ bridge, catalog });
}

export function createRouter(service, { toolProfile = "all" } = {}) {
  const tools = listedTools(toolProfile);
  const visibleToolNames = new Set(tools.map((tool) => tool.name));
  return async function route(request) {
    const { id, method, params = {} } = request;
    try {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw Object.assign(new Error("params must be an object"), { code: -32602 });
      }
      let result;
      if (method === "initialize") {
        result = {
          protocolVersion: SUPPORTED_PROTOCOL_VERSION,
          capabilities: { resources: {}, tools: {}, prompts: { listChanged: false } },
          serverInfo: { name: "ableton-mcp", version: PACKAGE_VERSION }
        };
      } else if (method === "resources/list") result = { resources };
      else if (method === "resources/templates/list") result = { resourceTemplates };
      else if (method === "resources/read") {
        const value = await service.readResource(params.uri);
        result = { contents: [{ uri: params.uri, text: JSON.stringify(value), mimeType: "application/json" }] };
      }
      else if (method === "tools/list") result = { tools };
      else if (method === "tools/call") {
        if (typeof params.name !== "string" || !params.name) {
          throw Object.assign(new Error("tool name is required"), { code: -32602 });
        }
        if (!visibleToolNames.has(params.name)) throw Object.assign(new Error(`unknown tool: ${params.name}`), { code: -32601 });
        const args = params.arguments === undefined ? {} : params.arguments;
        validateToolArguments(params.name, args);
        try {
          const value = await service.call(params.name, args);
          result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      }
      else if (method === "prompts/list") result = { prompts: listPrompts() };
      else if (method === "prompts/get") {
        const prompt = getPrompt(params.name, params.arguments);
        result = { description: prompt.description, messages: prompt.messages };
      }
      else throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: error.code || -32603, message: error.message } };
    }
  };
}

export async function runStdio({ service, toolProfile = "all" }) {
  const route = createRouter(service, { toolProfile });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`); continue; }
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      request.jsonrpc !== "2.0" || typeof request.method !== "string" || !request.method ||
      (Object.hasOwn(request, "id") && request.id !== null &&
        typeof request.id !== "string" && typeof request.id !== "number")) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } })}\n`);
      continue;
    }
    if (!Object.hasOwn(request, "id")) continue;
    process.stdout.write(`${JSON.stringify(await route(request))}\n`);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  if (process.env.ABLETON_MCP_FIXTURE === "1") {
    process.stderr.write("ableton-mcp fixture mode\n");
    await runStdio({ service: fixtureService(), toolProfile: process.env.ABLETON_MCP_TOOL_PROFILE || "all" });
  } else {
    try {
      const runtime = createConfiguredService(process.env);
      process.stderr.write("ableton-mcp configured runtime\n");
      await runStdio({ service: runtime.service, toolProfile: process.env.ABLETON_MCP_TOOL_PROFILE || "all" });
      runtime.close();
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
  }
}
