import { createInterface } from "node:readline";
import { ToolService } from "./tool-service.mjs";
import { PACKAGE_VERSION, isMainModule } from "./paths.mjs";
import { createConfiguredProducerService, createConfiguredService } from "./runtime.mjs";
import { toolContracts } from "./tool-contracts.mjs";
import { validateToolArguments, validateToolResult } from "./tool-validation.mjs";
import { getPrompt, listPrompts } from "./prompts.mjs";
import { withDiscoveryExamples } from "./discovery-examples.mjs";
import { withRequestSignal } from "./request-context.mjs";
import { producerToolContracts } from "./producer-contracts.mjs";
import { bridgeFailureDetails as requestFailure } from './bridge-client.mjs';

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
  'set_session_clip_entry',
  'get_parameter_automation_context', 're_enable_parameter_automation',
  'get_browser_preview_context', 'set_browser_preview',
  'get_selected_parameter_context', 'set_selected_parameter',
  'get_midi_note_removal_context', 'remove_midi_notes',
  'get_midi_note_insertion_context', 'insert_midi_notes',
  'override_parameter_automation',
  "group_tracks",
  "get_track_grouping_status",
  "ungroup_tracks",
  "get_track_ungrouping_status",
  "get_live_object_colors",
  "set_live_object_colors",
  ...Object.keys(producerToolContracts),
  "audition_arrangement_passage",
  "return_tracks_to_arrangement",
  "get_crossfader_context", "set_crossfader_state",
  "get_mixer_panning_context", "set_mixer_panning",
  "get_producer_workflow",
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
  "get_selection_context",
  "show_live_object",
  "get_session_orientation",
  "analyze_midi_parts",
  "analyze_arrangement_section",
  "plan_arrangement_repeat",
  "record_arrangement_take", "get_arrangement_take", "finish_arrangement_take",
  "capture_live_audio", "get_live_audio_capture", "finish_live_audio_capture",
  "get_instrument_comparison", "prepare_instrument_comparison", "adopt_instrument_comparison", "select_instrument_comparison",
  "duplicate_midi_clip_variations",
  "open_live_set",
  "save_live_set",
  "export_audio_mix",
  "export_audio_track",
  "export_midi_clip",
  "bounce_track_in_place",
  "save_native_device_preset",
  "get_project_media",
  "collect_project_media",
  "import_midi_file",
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
  "get_midi_capture_context",
  "capture_midi_session",
  "set_transport_recording_context",
  "list_arrangement_cue_points",
  "create_arrangement_cue_point",
  "rename_arrangement_cue_point",
  "delete_arrangement_cue_point",
  "jump_to_arrangement_cue_point",
  "list_tracks",
  "list_scenes",
  "get_scene_launch_context",
  "get_take_lane_context",
  "get_take_lane_audition_context",
  "show_take_lanes",
  "select_take_lane_audition",
  "get_simpler_sample_state",
  "load_simpler_sample",
  "set_simpler_sample_region",
  "set_simpler_manual_slices",
  "set_clip_slot_stop_button",
  "list_clips",
  "get_midi_clip_notes",
  "get_midi_clip_notes_extended",
  "get_midi_note_selection",
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
  "plan_audio_midi_sketch",
  "analyze_audio_file",
  "compare_audio_reference",
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
  "get_track_signal_activity",
  "get_track_routing",
  "get_return_routing",
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
  "copy_arrangement_clip_to_track",
  "capture_session_scene",
  "create_audio_clip",
  "create_arrangement_audio_clip",
  "set_return_mixer",
  "list_factory_device_profiles",
  "get_factory_coverage",
  "get_factory_device_context",
  "get_plugin_integration_context",
  "get_rack_performance_context",
  "get_looper_performance_context",
  "get_looper_export_context",
  "export_looper_clip",
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
  "get_clip_mixer_envelope",
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
  "plan_group_system_recall",
  "recall_group_system_snapshot",
  "save_track_state_snapshot",
  "load_track_state_snapshot",
  "recall_track_state_snapshot",
  "recall_device_parameter_snapshot",
  "set_device_parameters",
  "set_looper_state",
  "set_beat_repeat_enabled",
  "perform_beat_repeat_fill", "get_beat_repeat_fill", "finish_beat_repeat_fill",
  'get_session_midi_overdub_context', 'set_session_midi_overdub',
  'record_session_arrangement', 'get_session_arrangement_recording', 'finish_session_arrangement_recording',
  "hold_session_clip", "get_session_clip_hold", "finish_session_clip_hold",
  "set_beat_repeat_grid",
  "set_beat_repeat_interval",
  "create_midi_clip",
  "create_arrangement_midi_clip",
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
  "set_track_volume_db",
  "set_track_send_db",
  "set_device_parameter_display",
  "get_device_ab_context",
  "rename_arrangement_clip",
  "reverse_audio_clip",
  "get_device_activation_context",
  "copy_device_ab_slot",
  "select_device_ab_slot",
  "create_clip_parameter_envelope",
  "create_clip_mixer_envelope",
  "stop_all_clips"
];
// A smaller first-session surface for hosts with a tight tool-context budget.
// The full catalog remains the default and every handler keeps its contract.
const coreToolNames = new Set([
  "get_selection_context", "get_session_orientation", "duplicate_midi_clip_variations",
  "search_presets", "get_preset", "get_preset_metadata",
  "get_live_state", "open_live_set", "save_live_set", "get_transport_context", "get_song_musical_context",
  "get_song_grid_reference", "get_transport_recording_context",
  "get_live_scale_reference", "list_live_scales",
  "list_tracks", "list_scenes", "list_clips", "list_arrangement_clips",
  "get_midi_clip_notes_extended", "get_clip_timing", "get_audio_clip_state",
  "get_track_mixer", "get_track_routing", "get_set_mixer",
  "route_tracks_to_return_bus",
  "list_producer_chain_blueprints", "get_producer_chain_blueprint",
  "list_browser_roots", "get_browser_items", "search_browser_items", "search_browser_roots", "load_browser_item",
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
  if (!["all", "core", "producer"].includes(profile)) throw new Error(`unknown tool profile: ${profile}`);
  const producerNames = new Set([...Object.keys(producerToolContracts), "get_producer_workflow", "get_live_state", "transport_stop", "panic"]);
  return toolNames.filter((name) => profile === "all" || (profile === "producer" ? producerNames : coreToolNames).has(name))
    .map((name) => ({ name, ...toolContracts[name] }));
}

function fixtureService() {
  const catalog = { search: ({ query }) => [{ id: "serum-2:fixture", name: query || "Deep" }] };
  const bridge = { request: async (method) => ({ method, stateVersion: 1, setFingerprint: "fixture" }) };
  return createConfiguredProducerService(new ToolService({ bridge, catalog }));
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
      } else if (method === "ping") result = {};
      else if (method === "resources/list") result = { resources };
      else if (method === "resources/templates/list") result = { resourceTemplates };
      else if (method === "resources/read") {
        const value = await service.readResource(params.uri);
        result = { contents: [{ uri: params.uri, text: JSON.stringify(value), mimeType: "application/json" }] };
      }
      else if (method === "tools/list") result = { tools: toolProfile !== "producer" && typeof service.discoveryExamples === "function"
        ? withDiscoveryExamples(tools, await service.discoveryExamples()) : tools };
      else if (method === "tools/call") {
        if (typeof params.name !== "string" || !params.name) {
          throw Object.assign(new Error("tool name is required"), { code: -32602 });
        }
        if (!visibleToolNames.has(params.name)) throw Object.assign(new Error(`unknown tool: ${params.name}`), { code: -32601 });
        const args = params.arguments === undefined ? {} : params.arguments;
        validateToolArguments(params.name, args);
        try {
          const value = await service.call(params.name, args);
          validateToolResult(params.name, value);
          result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
          const failure = requestFailure(error);
          if (failure) result.structuredContent = { error: failure };
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
      const failure = requestFailure(error);
      return { jsonrpc: "2.0", id, error: { code: typeof error.code === "number" ? error.code : -32603,
        message: error.message, ...(failure ? { data: failure } : {}) } };
    }
  };
}

export async function runStdio({ service, toolProfile = "all", input = process.stdin, output = process.stdout }) {
  const route = createRouter(service, { toolProfile });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Map();
  const specialistTasks = new Set();
  let queue = Promise.resolve();
  let disconnected = false;
  const disconnect = () => {
    disconnected = true;
    for (const active of pending.values()) active.controller.abort(new Error("MCP output disconnected"));
  };
  output.on("close", disconnect);
  output.on("error", disconnect);
  const send = reply => {
    if (disconnected) return;
    return new Promise(resolve => {
      const finish = () => {
        output.off("error", finish);
        output.off("close", finish);
        resolve();
      };
      output.once("error", finish);
      output.once("close", finish);
      output.write(`${JSON.stringify(reply)}\n`, error => {
        // Writable emits an error after its failed write callback. Keep ownership
        // until that event (or close), including for the final response.
        if (!error) finish();
      });
    });
  };
  const enqueue = callback => { queue = queue.then(callback); };
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { enqueue(() => send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })); continue; }
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      request.jsonrpc !== "2.0" || typeof request.method !== "string" || !request.method ||
      (Object.hasOwn(request, "id") && request.id !== null &&
        typeof request.id !== "string" && typeof request.id !== "number")) {
      enqueue(() => send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }));
      continue;
    }
    if (!Object.hasOwn(request, "id")) {
      if (request.method === "notifications/cancelled") {
        const id = request.params?.requestId;
        const active = (typeof id === "string" || typeof id === "number") ? pending.get(id) : undefined;
        if (active && active.method !== "initialize") active.controller.abort(new Error("MCP request cancelled"));
      }
      continue;
    }
    if (pending.has(request.id) || pending.size >= 32) {
      const message = pending.has(request.id) ? "request ID is already pending" : "too many pending requests";
      enqueue(() => send({ jsonrpc: "2.0", id: request.id, error: { code: -32600,
        message } }));
      continue;
    }
    const active = { controller: new AbortController(), method: request.method };
    pending.set(request.id, active);
    const dispatch = async () => {
      try {
        if (disconnected || active.controller.signal.aborted) return;
        const reply = await withRequestSignal(active.controller.signal, () => route(request));
        if (!active.controller.signal.aborted) await send(reply);
      } finally {
        pending.delete(request.id);
      }
    };
    if (request.method === "tools/call" && (request.params?.name === "run_production_task" ||
        (request.params?.name === "advance_production_session" && request.params?.arguments?.action === "propose"))) {
      // Proposal work cannot mutate Live and must not hold the control queue.
      const task = dispatch();
      specialistTasks.add(task);
      task.then(() => specialistTasks.delete(task), () => specialistTasks.delete(task));
    } else enqueue(dispatch);
  }
  // CLI callers may half-close stdin after sending their requests.
  await queue;
  await Promise.all(specialistTasks);
  output.off("close", disconnect);
  output.off("error", disconnect);
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
