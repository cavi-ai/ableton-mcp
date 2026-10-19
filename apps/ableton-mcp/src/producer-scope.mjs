const ownerOf = id => typeof id === "string" ? /^(master|(?:track|return)-\d+)(?=:|$)/.exec(id)?.[1] : undefined;
const trackFields = new Set(["trackId", "trackIds", "sourceTrackId", "targetTrackId", "destinationTrackId", "busTrackId", "groupTrackId", "returnTrackId"]);
const deviceFields = new Set(["deviceId", "targetDeviceId"]);
const chainFields = new Set(["chainId", "targetChainId"]);
const clipFields = new Set(["clipId", "clipIds", "sourceClipId", "destinationClipId", "takeClipId"]);
const objectFields = new Set(["objectId", "objectIds", "targetId"]);
const returnReferences = new Set(["set_track_send_db", "create_clip_mixer_envelope", "get_clip_mixer_envelope"]);
// Existing song-level proposals remain available alongside an exact part scope.
const songOperations = new Set(["set_tempo", "set_song_musical_context"]);
const scopePatterns = {
  trackId: /^(?:master|(?:track|return)-(?:0|[1-9][0-9]*))$/,
  clipId: /^track-(?:0|[1-9][0-9]*):(?:arrangement-)?clip-(?:0|[1-9][0-9]*)$/,
  deviceId: /^(?:master|(?:track|return)-(?:0|[1-9][0-9]*)):device-(?:0|[1-9][0-9]*)(?:\/(?:return-)?chain-(?:0|[1-9][0-9]*)\/device-(?:0|[1-9][0-9]*))*$/
};

export function validateProducerScope(scope = {}) {
  for (const [key, pattern] of Object.entries(scopePatterns))
    if (scope[key] !== undefined && (typeof scope[key] !== "string" || !pattern.test(scope[key])))
      throw new Error(`producer scope ${key} requires a canonical Live ID`);
  const owners = new Set(Object.keys(scopePatterns).filter(key => scope[key] !== undefined).map(key => ownerOf(scope[key])));
  if (owners.size > 1) throw new Error("producer scope IDs must belong to the same owner");
}

export function assertProducerScope(tool, args, scope, { write = false } = {}) {
  validateProducerScope(scope);
  if (!scope.trackId && !scope.clipId && !scope.deviceId) return;
  const owner = scope.trackId || ownerOf(scope.clipId) || ownerOf(scope.deviceId);
  let targets = 0;
  const check = (id, kind, destination = false) => {
    if (typeof id !== "string") return; // Argument-schema validation rejects other types.
    targets++;
    const observedOwner = ownerOf(id);
    if (owner && (observedOwner !== owner || (kind === "track" && id !== observedOwner)))
      throw new Error(`specialist target ${id} is outside task scope`);
    if (!destination && ((kind === "clip" && scope.clipId && id !== scope.clipId) ||
        (kind === "device" && scope.deviceId && id !== scope.deviceId)))
      throw new Error(`specialist ${kind} target is outside task scope`);
  };
  const visit = (value, path = []) => {
    if (Array.isArray(value)) { for (const item of value) visit(item, path); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      // Imported snapshots/templates carry provenance, not additional Live targets.
      if (path.length === 0 && ["snapshot", "template"].includes(key)) continue;
      if (key === "returnTrackId" && returnReferences.has(tool)) continue;
      const values = Array.isArray(item) ? item : [item];
      if (trackFields.has(key)) for (const id of values) check(id, "track");
      else if (deviceFields.has(key)) for (const id of values) check(id, "device");
      else if (chainFields.has(key)) for (const id of values) {
        const parent = typeof id === "string" && /^(.*)\/(?:return-)?chain-\d+$/.exec(id)?.[1];
        if (!parent) throw new Error("specialist chain target cannot be resolved for task scope");
        check(parent, "device");
      }
      else if (clipFields.has(key)) {
        const destination = key === "destinationClipId" || (tool === "duplicate_midi_clip_variations" && path[0] === "variants");
        for (const id of values) check(id, "clip", destination);
      } else if (objectFields.has(key)) for (const id of values) {
        check(id, typeof id === "string" && /:(?:arrangement-)?clip-/.test(id) ? "clip"
          : typeof id === "string" && id.includes(":device-") ? "device" : "track");
      }
      else visit(item, [...path, key]);
    }
  };
  visit(args);
  if (tool === "set_master_mixer") check("master", "track");
  if (write && !targets && !songOperations.has(tool))
    throw new Error("specialist operation has no verifiable target for this task scope");
}
