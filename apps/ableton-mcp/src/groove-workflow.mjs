import { isDeepStrictEqual } from "node:util";

function withoutVersions(value) {
  if (Array.isArray(value)) return value.map(withoutVersions);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "stateVersion").map(([key, item]) => [key, withoutVersions(item)]));
  return value;
}

export function inspectGroovePostconditions(operation, before, after) {
  if (!["bake", "extract"].includes(operation)) throw new Error("unknown groove operation");
  for (const key of ["trackId", "clipId", "trackName", "clipName"]) {
    if (typeof before?.[key] !== "string" || before[key] !== after?.[key]) throw new Error("clip identity changed or missing");
  }
  if (!before.source?.content || !after.source?.content || before.source.type !== after.source.type) throw new Error("source content missing or type changed");
  if (!before.timing || !after.timing || !before.musicalContext?.groove?.pool || !after.musicalContext?.groove?.pool) throw new Error("groove context missing");
  for (const snapshot of [before, after]) {
    const content = snapshot.source.content, pool = snapshot.musicalContext.groove.pool;
    if (!["midi", "audio"].includes(snapshot.source.type)) throw new Error("invalid source type");
    for (const nested of [content, snapshot.timing]) {
      if (nested.trackId !== snapshot.trackId || nested.clipId !== snapshot.clipId) throw new Error("nested clip identity missing or changed");
    }
    if (!Array.isArray(pool) || pool.some(groove => !groove || typeof groove.id !== "string" || typeof groove.name !== "string") || new Set(pool.map(groove => groove.id)).size !== pool.length) throw new Error("invalid groove pool");
    if (snapshot.timing.grooveId !== null && !pool.some(groove => groove.id === snapshot.timing.grooveId)) throw new Error("groove assignment missing from pool");
    if (snapshot.source.type === "midi") {
      if (!Number.isFinite(content.lengthBeats) || content.lengthBeats <= 0 || !Array.isArray(content.notes) || content.notes.some(note => !note || !Number.isInteger(note.noteId) || typeof note.mute !== "boolean" || ![note.pitch, note.start, note.duration, note.velocity, note.velocityDeviation, note.releaseVelocity, note.probability].every(Number.isFinite) || note.duration <= 0)) throw new Error("invalid MIDI source content");
    } else {
      if (typeof content.source?.path !== "string" || !Number.isFinite(content.source.lengthSamples) || content.source.lengthSamples <= 0 || typeof content.warping !== "boolean" || !Number.isFinite(content.gain?.value) || !Number.isFinite(content.pitch?.coarse) || !Number.isFinite(content.pitch?.fine) || !Number.isInteger(content.warpMode?.value) || !Array.isArray(content.warpMarkers?.markers)) throw new Error("invalid audio source content");
      for (const region of [content.markers, content.loop]) {
        const suffix = content.warping ? "Beats" : "Seconds";
        if (!region || region.unit !== (content.warping ? "beats" : "seconds") || !Number.isFinite(region[`start${suffix}`]) || !Number.isFinite(region[`end${suffix}`])) throw new Error("invalid audio region content");
      }
      if (typeof content.loop.enabled !== "boolean") throw new Error("invalid audio loop content");
    }
  }
  const sourceContentChanged = !isDeepStrictEqual(withoutVersions(before.source), withoutVersions(after.source));
  const previousContext = withoutVersions(before.musicalContext), currentContext = withoutVersions(after.musicalContext);
  let addedGroove;
  if (operation === "extract") {
    if (sourceContentChanged) throw new Error("extraction source content changed");
    if (!isDeepStrictEqual(withoutVersions(before.timing), withoutVersions(after.timing))) throw new Error("extraction clip timing changed");
    const pool = currentContext.groove.pool;
    if (pool.length !== previousContext.groove.pool.length + 1) throw new Error("expected exactly one appended groove");
    addedGroove = pool.at(-1);
    currentContext.groove.pool = pool.slice(0, -1);
  } else {
    if (typeof before.timing.grooveId !== "string" || after.timing.grooveId !== null) throw new Error("bake groove assignment postcondition not observed");
    const previousTiming = withoutVersions(before.timing), currentTiming = withoutVersions(after.timing);
    delete previousTiming.grooveId;
    delete currentTiming.grooveId;
    if (!isDeepStrictEqual(previousTiming, currentTiming)) throw new Error("unrelated clip timing changed");
  }
  if (!isDeepStrictEqual(previousContext, currentContext)) throw new Error("shared musical context changed unexpectedly");
  return { operation, postconditionsObserved: true, actionProvenanceVerified: false,
    sourceContentChanged, ...(addedGroove ? { addedGroove } : {}) };
}
