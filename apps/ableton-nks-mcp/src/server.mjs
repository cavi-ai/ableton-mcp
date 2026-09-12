import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { ToolService } from "./tool-service.mjs";
import { createConfiguredService } from "./runtime.mjs";

const resources = [
  "nks://catalog/products",
  "nks://catalog/presets/{preset_id}",
  "nks://catalog/artwork/{artwork_id}",
  "ableton://live/status",
  "ableton://set/tracks",
  "ableton://set/scenes",
  "ableton://track/{track_id}/clips",
  "ableton://track/{track_id}/devices",
  "ableton://device/{device_id}/parameters",
  "komplete://automation/status"
].map((uri) => ({ uri, name: uri }));

const toolNames = [
  "search_presets",
  "get_preset",
  "get_live_state",
  "list_tracks",
  "list_scenes",
  "list_clips",
  "get_midi_clip_notes",
  "get_midi_clip_notes_extended",
  "get_automation_capabilities",
  "get_track_mixer",
  "get_clip_parameter_envelope",
  "list_devices",
  "list_device_parameters",
  "set_device_parameters",
  "create_midi_clip",
  "set_clip_parameter_envelope",
  "set_midi_note_properties",
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
const tools = toolNames.map((name) => ({
  name,
  description: `Ableton NKS operation: ${name}`,
  inputSchema: { type: "object", additionalProperties: true }
}));

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
        const value = await service.call(params.name, params.arguments || {});
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
