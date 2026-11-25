import { createInterface } from "node:readline";
import { ToolService } from "./tool-service.mjs";
import { PACKAGE_VERSION, isMainModule } from "./paths.mjs";
import { runtimeIdentity, withRuntimeIdentity } from "./runtime-identity.mjs";
import { createConfiguredService } from "./runtime.mjs";
import { toolContracts } from "./tool-contracts.mjs";
import { compactOutputNames, extensibleToolResult, withToolErrorSchema } from "./tool-output-contracts.mjs";
import { validateToolArguments, validateToolResult } from "./tool-validation.mjs";
import { withDiscoveryExamples } from "./discovery-examples.mjs";
import { withRequestSignal } from "./request-context.mjs";
import { bridgeFailureDetails as requestFailure } from './bridge-client.mjs';
import { normalizeSlices, normalizeToolNames, resourceUrisForSlices, resourceVisible, sessionSelection, toolsForSlices } from "./tool-slices.mjs";

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

// Legacy profile aliases. `serve` with no profile and no slices advertises `observe` only.
// Handlers stay registered; a session can call only the tools it advertises.
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
  if (!["all", "core", "directory"].includes(profile)) throw new Error(`unknown tool profile: ${profile}`);
  return Object.keys(toolContracts).filter((name) => profile !== "core" || coreToolNames.has(name))
    .map((name) => advertiseTool(name, profile === "core"));
}

function advertiseTool(name, compact) {
  return { name, ...toolContracts[name], outputSchema: compact
    ? compactOutputNames.has(name) ? toolContracts[name].outputSchema : extensibleToolResult
    : withToolErrorSchema(toolContracts[name].outputSchema) };
}

function slicedTools(slices) {
  const selected = toolsForSlices(slices);
  return Object.keys(toolContracts).filter((name) => selected.has(name)).map((name) => advertiseTool(name, true));
}

export function sessionSurface({ toolProfile, toolSlices, toolNames } = {}) {
  if ([toolProfile, toolSlices, toolNames].filter((value) => value !== undefined).length > 1)
    throw new Error("tool profile, tool slices, and tool names are mutually exclusive");
  if (toolNames !== undefined) {
    const names = normalizeToolNames(toolNames);
    const selected = new Set(names);
    return { kind: "tools", toolNames: names, prompts: [], resourceUris: [], examples: false,
      tools: Object.keys(toolContracts).filter((name) => selected.has(name)).map((name) => advertiseTool(name, true)) };
  }
  if (toolSlices !== undefined) {
    const slices = normalizeSlices(toolSlices);
    return { kind: "slices", slices, tools: slicedTools(slices), prompts: [], resourceUris: resourceUrisForSlices(slices), examples: false };
  }
  const profile = toolProfile ?? "all";
  return { kind: "profile", profile, tools: listedTools(profile), prompts: [], resourceUris, examples: true };
}

export function sessionLogLine(options) {
  const surface = sessionSurface(options);
  const baseSchemaBytes = Buffer.byteLength(JSON.stringify(surface.tools));
  const label = surface.kind === "tools" ? `allowlist=${surface.toolNames.join(",")}`
    : surface.kind === "slices" ? `slices=${surface.slices.join(",")}` : `profile=${surface.profile}`;
  return `ableton-mcp session ${label} tools=${surface.tools.length} baseSchemaBytes=${baseSchemaBytes}\n`;
}

function fixtureService() {
  const catalog = { search: ({ query }) => [{ id: "serum-2:fixture", name: query || "Deep" }] };
  const bridge = { request: async (method) => ({ method, stateVersion: 1, setFingerprint: "fixture" }) };
  return new ToolService({ bridge, catalog });
}

export function createRouter(service, options = {}) {
  const surface = sessionSurface(options.toolProfile === undefined && options.toolSlices === undefined && options.toolNames === undefined
    ? { toolProfile: "all" } : options);
  const tools = surface.tools;
  const visibleToolNames = new Set(tools.map((tool) => tool.name));
  const listedResources = surface.resourceUris.filter((uri) => !uri.includes("{"))
    .map((uri) => ({ uri, name: uri, mimeType: "application/json" }));
  const listedTemplates = surface.resourceUris.filter((uri) => uri.includes("{"))
    .map((uriTemplate) => ({ uriTemplate, name: uriTemplate, mimeType: "application/json" }));
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
          serverInfo: { name: "ableton-mcp", version: PACKAGE_VERSION },
          _meta: { "ai.cavi/runtime": runtimeIdentity() }
        };
      } else if (method === "ping") result = {};
      else if (method === "resources/list") result = { resources: listedResources };
      else if (method === "resources/templates/list") result = { resourceTemplates: listedTemplates };
      else if (method === "resources/read") {
        if (surface.kind !== "profile" && !resourceVisible(params.uri, surface.resourceUris))
          throw Object.assign(new Error(`unknown resource: ${params.uri}`), { code: -32601 });
        const value = await service.readResource(params.uri);
        result = { contents: [{ uri: params.uri, text: JSON.stringify(value), mimeType: "application/json" }] };
      }
      else if (method === "tools/list") result = { tools: surface.examples && typeof service.discoveryExamples === "function"
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
          validateToolResult(params.name, value, args);
          const output = withRuntimeIdentity(params.name, value);
          result = { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
          const failure = requestFailure(error);
          if (failure) result.structuredContent = { error: failure };
        }
      }
      else if (method === "prompts/list") result = { prompts: surface.prompts };
      else if (method === "prompts/get") throw Object.assign(new Error(`unknown prompt: ${params.name}`), { code: -32602 });
      else throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      const failure = requestFailure(error);
      return { jsonrpc: "2.0", id, error: { code: typeof error.code === "number" ? error.code : -32603,
        message: error.message, ...(failure ? { data: failure } : {}) } };
    }
  };
}

export async function runStdio({ service, toolProfile, toolSlices, toolNames, input = process.stdin, output = process.stdout, stderr = process.stderr } = {}) {
  const options = toolNames !== undefined ? { toolNames } : toolSlices !== undefined ? { toolSlices } : { toolProfile: toolProfile ?? "all" };
  stderr.write(sessionLogLine(options));
  const route = createRouter(service, options);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Map();
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
    enqueue(dispatch);
  }
  // CLI callers may half-close stdin after sending their requests.
  await queue;
  output.off("close", disconnect);
  output.off("error", disconnect);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const selection = sessionSelection(process.env);
    if (process.env.ABLETON_MCP_FIXTURE === "1") {
      process.stderr.write("ableton-mcp fixture mode\n");
      await runStdio({ service: fixtureService(), ...selection });
    } else {
      const runtime = createConfiguredService(process.env);
      process.stderr.write("ableton-mcp configured runtime\n");
      await runStdio({ service: runtime.service, ...selection });
      runtime.close();
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
