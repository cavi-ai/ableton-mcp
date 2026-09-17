const EPSILON = 2e-7;
const MAX_NOTES = 4096;

function collisionPairs(notes) {
  const pairs = new Set();
  for (let left = 0; left < notes.length; left += 1) {
    for (let right = left + 1; right < notes.length; right += 1) {
      const a = notes[left];
      const b = notes[right];
      if (a.pitch !== b.pitch) continue;
      if (a.start < b.start + b.duration - EPSILON && b.start < a.start + a.duration - EPSILON)
        pairs.add(`${Math.min(a.noteId, b.noteId)}:${Math.max(a.noteId, b.noteId)}`);
    }
  }
  return pairs;
}

function sameNote(left, right) {
  const exact = ["noteId", "pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"];
  return exact.every(field => left[field] === right[field]) &&
    Math.abs(left.start - right.start) <= EPSILON &&
    Math.abs(left.duration - right.duration) <= EPSILON;
}

export function planMidiStrumPattern(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || options.noteIds.length === 0 || options.noteIds.length > MAX_NOTES)
    throw new Error("noteIds must contain 1 to 4096 note IDs");
  if (new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must not contain a duplicate noteId");
  if (!["up", "down", "alternating"].includes(options.direction))
    throw new Error("direction must be up, down, or alternating");
  if (!Number.isFinite(options.spreadBeats) || options.spreadBeats <= 0 || options.spreadBeats > 4)
    throw new Error("spreadBeats must be greater than 0 and at most 4");

  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds);
  const selectedStarts = new Set(selected.map(note => note.start));
  if (clip.notes.some(note => selectedStarts.has(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("strum patterns require every note at each selected complete onset");
  const onsets = [...selectedStarts].sort((left, right) => left - right);
  const changes = [];
  onsets.forEach((start, onsetIndex) => {
    const chord = selected.filter(note => note.start === start);
    if (chord.length < 2) throw new Error("each strummed onset must contain at least two notes");
    const ascending = options.direction === "up" ||
      (options.direction === "alternating" && onsetIndex % 2 === 0);
    chord.sort((left, right) => ascending ? left.pitch - right.pitch || left.noteId - right.noteId :
      right.pitch - left.pitch || left.noteId - right.noteId);
    const step = options.spreadBeats / (chord.length - 1);
    chord.forEach((previous, rank) => {
      const nextStart = start + step * rank;
      const nextDuration = previous.start + previous.duration - nextStart;
      if (nextDuration <= EPSILON)
        throw new Error("strum spread must leave every selected note with positive duration");
      changes.push({ noteId: previous.noteId, previous, start: nextStart, duration: nextDuration });
    });
  });
  const changedById = new Map(changes.map(change => [change.noteId, change]));
  const after = clip.notes.map(current => {
    const change = changedById.get(current.noteId);
    return change ? { ...current, start: change.start, duration: change.duration } : current;
  });
  const beforeCollisions = collisionPairs(clip.notes);
  if ([...collisionPairs(after)].some(pair => !beforeCollisions.has(pair)))
    throw new Error("strum pattern would create a same-pitch collision");
  if (after.some(note => note.start < -EPSILON || note.start + note.duration > clip.lengthBeats + EPSILON))
    throw new Error("strum pattern would extend a selected note beyond the clip");
  return { noteIds: [...options.noteIds], direction: options.direction,
    spreadBeats: options.spreadBeats, changes };
}

export function matchMidiStrumReadback(beforeNotes, changes, observedNotes) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(changes) || !Array.isArray(observedNotes) ||
      beforeNotes.length !== observedNotes.length) return false;
  const expected = new Map(beforeNotes.map(note => [note.noteId, { ...note }]));
  if (expected.size !== beforeNotes.length) return false;
  for (const change of changes) {
    const note = expected.get(change.noteId);
    if (!note) return false;
    note.start = change.start;
    note.duration = change.duration;
  }
  return new Set(observedNotes.map(note => note.noteId)).size === expected.size &&
    observedNotes.every(note => expected.has(note.noteId) && sameNote(expected.get(note.noteId), note));
}
