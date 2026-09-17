function finite(value, field, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be from ${minimum} to ${maximum}`);
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function overlaps(left, right) {
  return left.pitch === right.pitch && left.start < right.start + right.duration &&
    right.start < left.start + left.duration;
}

export function planMidiHumanization(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (!Array.isArray(options.noteIds) || options.noteIds.length === 0)
    throw new Error("noteIds must be a non-empty array");
  if (new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must not contain a duplicate noteId");
  integer(options.seed, "seed", 0, 4294967295);
  finite(options.gridBeats, "gridBeats", Number.EPSILON, 128);
  finite(options.maxTimingOffsetBeats, "maxTimingOffsetBeats", 0, 128);
  if (options.maxTimingOffsetBeats > options.gridBeats / 2)
    throw new Error("maxTimingOffsetBeats must not exceed half the grid");
  integer(options.maxVelocityOffset, "maxVelocityOffset", 0, 126);
  if (options.maxTimingOffsetBeats === 0 && options.maxVelocityOffset === 0)
    throw new Error("humanization must change timing or velocity");

  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const random = randomGenerator(options.seed);
  const changes = selected.map(previous => {
    const timing = (random() * 2 - 1) * options.maxTimingOffsetBeats;
    const velocityOffset = Math.round((random() * 2 - 1) * options.maxVelocityOffset);
    const start = Math.max(0, Math.min(clip.lengthBeats - previous.duration, previous.start + timing));
    const velocity = Math.max(1, Math.min(127, previous.velocity + velocityOffset));
    return { noteId: previous.noteId, previous, start, velocity };
  }).filter(change => change.start !== change.previous.start || change.velocity !== change.previous.velocity);
  if (changes.length === 0) throw new Error("humanization would not change any selected notes");

  const finalById = new Map(clip.notes.map(note => [note.noteId, { ...note }]));
  for (const change of changes) Object.assign(finalById.get(change.noteId), change);
  const final = [...finalById.values()];
  const changedIds = new Set(changes.map(change => change.noteId));
  for (let left = 0; left < final.length; left += 1) {
    for (let right = left + 1; right < final.length; right += 1) {
      if (!changedIds.has(final[left].noteId) && !changedIds.has(final[right].noteId)) continue;
      const beforeLeft = byId.get(final[left].noteId);
      const beforeRight = byId.get(final[right].noteId);
      if (overlaps(final[left], final[right]) && !overlaps(beforeLeft, beforeRight))
        throw new Error("humanization would create a same-pitch note collision");
    }
  }
  return { options: {
    seed: options.seed, gridBeats: options.gridBeats,
    maxTimingOffsetBeats: options.maxTimingOffsetBeats,
    maxVelocityOffset: options.maxVelocityOffset,
  }, noteIds: [...options.noteIds], changes };
}

export function matchMidiHumanizationReadback(beforeNotes, changes, observedNotes, tolerance = 2e-7) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(changes) || !Array.isArray(observedNotes) ||
      beforeNotes.length !== observedNotes.length) return false;
  const expected = new Map(beforeNotes.map(note => [note.noteId, { ...note }]));
  for (const change of changes) {
    const note = expected.get(change.noteId);
    if (!note) return false;
    if (change.start !== undefined) note.start = change.start;
    if (change.velocity !== undefined) note.velocity = change.velocity;
  }
  const fields = ["pitch", "duration", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"];
  if (new Set(observedNotes.map(note => note.noteId)).size !== expected.size ||
      observedNotes.some(note => !expected.has(note.noteId))) return false;
  return observedNotes.every(actual => {
    const wanted = expected.get(actual.noteId);
    return wanted && fields.every(field => wanted[field] === actual[field]) &&
      Math.abs(wanted.start - actual.start) <= tolerance;
  });
}
