import { toolContracts } from "./tool-contracts.mjs";
import { producerToolContracts } from "./producer-contracts.mjs";
import { rankNamedMetadata } from "./workflow-search.mjs";

export const readNames = ["get_live_state", "get_selection_context", "get_song_musical_context", "list_tracks", "list_clips",
  "list_devices", "list_device_parameters", "get_device_parameter_edit_context", "get_clip_timing",
  "get_midi_clip_notes_extended", "get_audio_clip_state", "get_track_mixer", "get_track_routing",
  "get_factory_device_context", "get_plugin_integration_context", "analyze_midi_clip_scale", "analyze_midi_clip_chords"];
export const operationNames = ["set_tempo", "set_song_musical_context", "set_device_parameters", "set_track_mixer", "set_track_volume_db", "set_track_send_db",
  "set_clip_timing", "set_audio_clip_state", "set_midi_note_properties", "transform_midi_notes",
  "duplicate_midi_clip_variations", "create_midi_clip", "set_device_active", "set_session_clip_entry"];
export const deferredReadNames = ["get_live_state", "get_selection_context", "get_song_musical_context"];
const executionFields = ["dryRun", "confirmationToken", "planHash", "expectedStateVersion"];
export const eligibleOperation = name => !Object.hasOwn(producerToolContracts, name) &&
  Boolean(toolContracts[name]?.inputSchema.properties.expectedStateVersion && toolContracts[name]?.inputSchema.properties.dryRun);
const namesFor = kind => Object.keys(toolContracts).filter(name => !Object.hasOwn(producerToolContracts, name) &&
  (kind === "operation" ? eligibleOperation(name) : toolContracts[name].annotations.readOnlyHint));
function argumentMetadata(schema, path = []) {
  if (!schema || typeof schema !== "object") return [];
  const fields = Object.entries(schema.properties || {}).filter(([key]) => path.length || !executionFields.includes(key));
  return [
    ...fields.flatMap(([name, property]) => [{ name: [...path, name].join("."), description: property.description || "" },
      ...argumentMetadata(property, [...path, name])]),
    ...argumentMetadata(schema.items, path),
    ...[...(schema.allOf || []), ...(schema.anyOf || []), ...(schema.oneOf || []),
      ...Object.values(schema.$defs || {}), ...Object.values(schema.definitions || {})].flatMap(branch => argumentMetadata(branch, path))
  ];
}
const catalog = Object.fromEntries(["read", "operation"].map(kind => [kind, namesFor(kind).map(name => ({
  name, description: toolContracts[name].description,
  arguments: argumentMetadata(toolContracts[name].inputSchema)
}))]));

export function operationSchema(name) {
  const schema = structuredClone(toolContracts[name].inputSchema);
  const stripGuardFields = node => {
    if (!node || typeof node !== "object") return;
    for (const key of executionFields) if (node.properties) delete node.properties[key];
    if (node.required) node.required = node.required.filter(key => !executionFields.includes(key));
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const branch of node[key] || []) stripGuardFields(branch);
    if (node.not) stripGuardFields(node.not);
  };
  stripGuardFields(schema);
  return { name, description: toolContracts[name].description, inputSchema: schema };
}

export const readSchema = name => ({ name, description: toolContracts[name].description, inputSchema: toolContracts[name].inputSchema });

function rankedNames(query, kind) {
  const exact = catalog[kind].find(tool => tool.name === query);
  if (exact) return [exact.name];
  try { return rankNamedMetadata(catalog[kind], query, { nameWeight: 200, termWeight: 10, nameDensityWeight: 100 }).matches.map(tool => tool.name); }
  catch (error) { if (/needs searchable words/.test(error.message)) return []; throw error; }
}

export function discoverProductionTools(args, role) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some(key => !["query", "kind", "offset"].includes(key)) ||
      typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 120 ||
      !["read", "operation"].includes(args.kind) ||
      (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > 10000)))
    throw new Error("invalid tool discovery arguments");
  if (role === "creative" && args.kind !== "read") throw new Error("creative operation discovery is not allowed");
  const matches = rankedNames(args.query, args.kind);
  const offset = args.offset || 0;
  return { names: matches.slice(offset, offset + 4), total: matches.length, nextOffset: offset + 4 < matches.length ? offset + 4 : null };
}

export function productionSchemas({ role, initialReads, deferred = false, intent = "change", goal = "" }) {
  initialReads ??= deferred ? deferredReadNames : readNames;
  const canChange = role === "functional" && intent !== "inspect";
  const tools = { reads: initialReads.filter(name => toolContracts[name]).map(readSchema),
    operations: canChange && !deferred ? operationNames.filter(eligibleOperation).map(operationSchema) : [],
    ...(deferred ? { available: { reads: namesFor("read"), operations: canChange ? namesFor("operation") : [] } } : {}),
    discovery: { tool: "discover_production_tools", args: { query: "words from the tool name or description", kind: "read or operation", offset: 0 },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Find at most four additional tool schemas. Creative may discover reads only. Operations are proposed, never executed by a specialist." },
    artifactRead: { tool: "read_production_artifact", args: { artifactId: "ID present in this task", offset: 0, limit: 4000 },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } } };
  if (deferred && goal.trim()) {
    let bytes = Buffer.byteLength(JSON.stringify({ reads: tools.reads, operations: tools.operations }));
    for (const kind of [...(canChange ? ["operation"] : []), "read"]) {
      let selected = 0;
      for (const name of rankedNames(goal.slice(0, 200), kind)) {
        const target = kind === "read" ? tools.reads : tools.operations;
        if (target.some(tool => tool.name === name)) continue;
        const schema = kind === "read" ? readSchema(name) : operationSchema(name);
        const cost = Buffer.byteLength(JSON.stringify(schema));
        if (bytes + cost > 8000) continue;
        target.push(schema); bytes += cost;
        if (++selected === 2) break;
      }
    }
  }
  return tools;
}
