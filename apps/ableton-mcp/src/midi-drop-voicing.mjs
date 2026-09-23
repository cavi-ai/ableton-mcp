const EPSILON = 2e-7;
const MAX_NOTES = 4096;

function collisions(notes) {
  const pairs = new Set();
  for (let left = 0; left < notes.length; left += 1) for (let right = left + 1; right < notes.length; right += 1) {
    const a = notes[left], b = notes[right];
    if (a.pitch === b.pitch && a.start < b.start + b.duration - EPSILON && b.start < a.start + a.duration - EPSILON)
      pairs.add(`${Math.min(a.noteId, b.noteId)}:${Math.max(a.noteId, b.noteId)}`);
  }
  return pairs;
}

function sameNote(left, right) {
  return ["noteId", "pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"]
    .every(field => left[field] === right[field]) && Math.abs(left.start - right.start) <= EPSILON &&
    Math.abs(left.duration - right.duration) <= EPSILON;
}

export function planMidiDropVoicing(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!["drop_2", "drop_3", "drop_2_and_4"].includes(options.mode))
    throw new Error("mode must be drop_2, drop_3, or drop_2_and_4");
  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const note = byId.get(noteId); if (!note) throw new Error(`unknown noteId ${noteId}`); return note;
  });
  const selectedIds = new Set(options.noteIds), starts = new Set(selected.map(note => note.start));
  if (clip.notes.some(note => starts.has(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("drop voicings require every note at each selected complete onset");
  const changes = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const chord = selected.filter(note => note.start === start).sort((a, b) => a.pitch - b.pitch || a.noteId - b.noteId);
    const minimum = options.mode === "drop_2" ? 3 : 4;
    if (chord.length < minimum) throw new Error(`mode ${options.mode} requires at least ${minimum === 3 ? "three" : "four"} notes per onset`);
    const droppedRanks = options.mode === "drop_2" ? [chord.length - 2] :
      options.mode === "drop_3" ? [chord.length - 3] : [chord.length - 2, chord.length - 4];
    chord.forEach((previous, rank) => {
      const pitch = previous.pitch - (droppedRanks.includes(rank) ? 12 : 0);
      if (pitch < 0) throw new Error("drop voicing would exceed the MIDI pitch range");
      changes.push({ noteId: previous.noteId, previous, pitch });
    });
  }
  const changed = new Map(changes.map(change => [change.noteId, change.pitch]));
  const after = clip.notes.map(note => ({ ...note, pitch: changed.get(note.noteId) ?? note.pitch }));
  const beforePairs = collisions(clip.notes);
  if ([...collisions(after)].some(pair => !beforePairs.has(pair))) throw new Error("drop voicing would create a same-pitch collision");
  return { noteIds: [...options.noteIds], mode: options.mode, changes };
}

export function matchMidiDropVoicingReadback(beforeNotes, changes, observedNotes) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(changes) || !Array.isArray(observedNotes) || beforeNotes.length !== observedNotes.length) return false;
  const expected = new Map(beforeNotes.map(note => [note.noteId, { ...note }]));
  if (expected.size !== beforeNotes.length) return false;
  for (const change of changes) { const note = expected.get(change.noteId); if (!note) return false; note.pitch = change.pitch; }
  return new Set(observedNotes.map(note => note.noteId)).size === expected.size &&
    observedNotes.every(note => expected.has(note.noteId) && sameNote(expected.get(note.noteId), note));
}
