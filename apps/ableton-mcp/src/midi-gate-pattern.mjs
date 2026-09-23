const EPSILON = 2e-7;

function samePitchCollisions(notes) {
  const collisions = new Set();
  const byPitch = new Map();
  for (const current of notes) {
    const group = byPitch.get(current.pitch) ?? [];
    group.push(current);
    byPitch.set(current.pitch, group);
  }
  for (const group of byPitch.values()) {
    group.sort((left, right) => left.start - right.start || left.noteId - right.noteId);
    for (let index = 1; index < group.length; index += 1) {
      for (let previous = 0; previous < index; previous += 1) {
        if (group[previous].start + group[previous].duration > group[index].start + EPSILON)
          collisions.add(`${Math.min(group[previous].noteId, group[index].noteId)}:${Math.max(group[previous].noteId, group[index].noteId)}`);
      }
    }
  }
  return collisions;
}

export function planMidiGatePattern(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (new Set(clip.notes.map(current => current.noteId)).size !== clip.notes.length)
    throw new Error("clip notes must have unique note IDs");
  if (!Array.isArray(options?.noteIds) || options.noteIds.length === 0)
    throw new Error("noteIds must be a non-empty array");
  if (options.noteIds.length > 4096) throw new Error("noteIds supports at most 4096 notes");
  if (new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must not contain a duplicate noteId");
  if (!Number.isFinite(options.gridBeats) || options.gridBeats <= 0 || options.gridBeats > 128)
    throw new Error("gridBeats must be greater than 0 and at most 128");
  if (!Array.isArray(options.gateRatios) || options.gateRatios.length === 0 || options.gateRatios.length > 128)
    throw new Error("gateRatios must contain 1 to 128 values");
  options.gateRatios.forEach((ratio, index) => {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1)
      throw new Error(`gateRatios[${index}] must be greater than 0 and at most 1`);
  });
  const byId = new Map(clip.notes.map(current => [current.noteId, current]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds);
  const selectedStarts = new Set(selected.map(current => current.start));
  if (clip.notes.some(current => selectedStarts.has(current.start) && !selectedIds.has(current.noteId)))
    throw new Error("gate patterns require every note at each selected complete onset");
  const onsets = [...selectedStarts].sort((left, right) => left - right);
  const durationByStart = new Map(onsets.map((start, index) => [
    start, options.gridBeats * options.gateRatios[index % options.gateRatios.length],
  ]));
  const changes = selected
    .map(previous => ({ noteId: previous.noteId, previous, duration: durationByStart.get(previous.start) }))
    .filter(change => Math.abs(change.duration - change.previous.duration) > EPSILON);
  if (changes.length === 0) throw new Error("gate pattern would not change any selected notes");
  if (changes.some(change => change.previous.start + change.duration > clip.lengthBeats + EPSILON))
    throw new Error("gate pattern would extend a selected note beyond the clip");
  const changedById = new Map(changes.map(change => [change.noteId, change.duration]));
  const after = clip.notes.map(current => ({
    ...current, duration: changedById.get(current.noteId) ?? current.duration,
  }));
  const beforeCollisions = samePitchCollisions(clip.notes);
  if ([...samePitchCollisions(after)].some(pair => !beforeCollisions.has(pair)))
    throw new Error("gate pattern would create a same-pitch collision");
  return { noteIds: [...options.noteIds], gridBeats: options.gridBeats,
    gateRatios: [...options.gateRatios], changes };
}

export function matchMidiGatePatternReadback(beforeNotes, changes, observedNotes, tolerance = EPSILON) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(changes) || !Array.isArray(observedNotes) ||
      beforeNotes.length !== observedNotes.length) return false;
  const expected = new Map(beforeNotes.map(current => [current.noteId, { ...current }]));
  if (expected.size !== beforeNotes.length) return false;
  for (const change of changes) {
    const current = expected.get(change.noteId);
    if (!current) return false;
    current.duration = change.duration;
  }
  if (new Set(observedNotes.map(current => current.noteId)).size !== expected.size ||
      observedNotes.some(current => !expected.has(current.noteId))) return false;
  const exactFields = ["pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"];
  return observedNotes.every(actual => {
    const wanted = expected.get(actual.noteId);
    return exactFields.every(field => wanted[field] === actual[field]) &&
      Math.abs(wanted.start - actual.start) <= tolerance &&
      Math.abs(wanted.duration - actual.duration) <= tolerance;
  });
}
