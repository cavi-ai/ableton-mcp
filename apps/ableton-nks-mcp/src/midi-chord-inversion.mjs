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

export function planMidiChordInversion(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || options.noteIds.length === 0 || options.noteIds.length > MAX_NOTES)
    throw new Error("noteIds must contain 1 to 4096 note IDs");
  if (new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must not contain a duplicate noteId");
  if (!['up', 'down'].includes(options.direction))
    throw new Error("direction must be up or down");
  if (!Number.isInteger(options.steps) || options.steps < 1 || options.steps > 127)
    throw new Error("steps must be an integer from 1 to 127");

  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds);
  const selectedStarts = new Set(selected.map(note => note.start));
  if (clip.notes.some(note => selectedStarts.has(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("chord inversions require every note at each selected complete onset");

  const changes = [];
  for (const start of [...selectedStarts].sort((left, right) => left - right)) {
    const chord = selected.filter(note => note.start === start)
      .sort((left, right) => left.pitch - right.pitch || left.noteId - right.noteId);
    if (chord.length < 2) throw new Error("each inverted onset must contain at least two notes");
    chord.forEach((previous, rank) => {
      const octaves = options.direction === "up"
        ? Math.floor((options.steps + chord.length - 1 - rank) / chord.length)
        : Math.floor((options.steps + rank) / chord.length);
      const pitch = previous.pitch + octaves * (options.direction === "up" ? 12 : -12);
      if (pitch < 0 || pitch > 127) throw new Error("chord inversion would exceed the MIDI pitch range");
      changes.push({ noteId: previous.noteId, previous, pitch });
    });
  }

  const changedById = new Map(changes.map(change => [change.noteId, change]));
  const after = clip.notes.map(current => ({ ...current,
    pitch: changedById.get(current.noteId)?.pitch ?? current.pitch,
  }));
  const beforeCollisions = collisionPairs(clip.notes);
  if ([...collisionPairs(after)].some(pair => !beforeCollisions.has(pair)))
    throw new Error("chord inversion would create a same-pitch collision");
  return { noteIds: [...options.noteIds], direction: options.direction, steps: options.steps, changes };
}

export function matchMidiChordInversionReadback(beforeNotes, changes, observedNotes) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(changes) || !Array.isArray(observedNotes) ||
      beforeNotes.length !== observedNotes.length) return false;
  const expected = new Map(beforeNotes.map(note => [note.noteId, { ...note }]));
  if (expected.size !== beforeNotes.length) return false;
  for (const change of changes) {
    const note = expected.get(change.noteId);
    if (!note) return false;
    note.pitch = change.pitch;
  }
  return new Set(observedNotes.map(note => note.noteId)).size === expected.size &&
    observedNotes.every(note => expected.has(note.noteId) && sameNote(expected.get(note.noteId), note));
}
