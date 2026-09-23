const EPSILON = 2e-7;
const MAX_NOTES = 4096;

function overlaps(left, right) {
  return left.start < right.start + right.duration - EPSILON &&
    right.start < left.start + left.duration - EPSILON;
}

function sameNote(left, right) {
  return ["noteId", "pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"]
    .every(field => left[field] === right[field]) &&
    Math.abs(left.start - right.start) <= EPSILON && Math.abs(left.duration - right.duration) <= EPSILON;
}

export function planMidiTransposition(clip, options) {
  if (!Array.isArray(clip?.notes) || clip.notes.length > MAX_NOTES ||
      new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!Number.isInteger(options.semitones) || options.semitones < -127 || options.semitones > 127 || options.semitones === 0)
    throw new Error("semitones must be a non-zero integer from -127 through 127");

  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selectedIds = new Set(options.noteIds);
  const changes = options.noteIds.map(noteId => {
    const previous = byId.get(noteId);
    if (!previous) throw new Error(`unknown noteId ${noteId}`);
    const pitch = previous.pitch + options.semitones;
    if (pitch < 0 || pitch > 127) throw new Error("transposition would exceed the MIDI range");
    return { noteId, previous, pitch };
  });
  const retained = clip.notes.filter(note => !selectedIds.has(note.noteId));
  for (const change of changes) {
    const candidate = { ...change.previous, pitch: change.pitch };
    if (retained.some(note => note.pitch === candidate.pitch && overlaps(note, candidate)))
      throw new Error("transposition would create a same-pitch collision");
  }
  return { noteIds: [...options.noteIds], semitones: options.semitones, changes };
}

export function matchMidiTranspositionReadback(beforeNotes, plan, finalNotes) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(finalNotes) || finalNotes.length !== beforeNotes.length)
    return false;
  const changes = new Map(plan.changes.map(change => [change.noteId, change]));
  const byId = new Map(finalNotes.map(note => [note.noteId, note]));
  if (byId.size !== finalNotes.length) return false;
  return beforeNotes.every(original => {
    const change = changes.get(original.noteId);
    const expected = change ? { ...original, pitch: change.pitch } : original;
    const actual = byId.get(original.noteId);
    return actual && sameNote(expected, actual);
  });
}
