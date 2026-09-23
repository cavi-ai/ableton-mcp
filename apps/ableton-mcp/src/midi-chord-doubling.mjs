const EPSILON = 2e-7;
const MAX_NOTES = 4096;

function overlaps(left, right) {
  return left.start < right.start + right.duration - EPSILON &&
    right.start < left.start + left.duration - EPSILON;
}

function sameNoteShape(left, right) {
  return ["pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"]
    .every(field => left[field] === right[field]) &&
    Math.abs(left.start - right.start) <= EPSILON && Math.abs(left.duration - right.duration) <= EPSILON;
}

function duplicate(source, pitch) {
  return { sourceNoteId: source.noteId, pitch, start: source.start, duration: source.duration,
    velocity: source.velocity, velocityDeviation: source.velocityDeviation,
    releaseVelocity: source.releaseVelocity, probability: source.probability, mute: source.mute };
}

export function planMidiChordDoubling(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!["bass_octave_down", "top_octave_up", "outer_octaves"].includes(options.mode))
    throw new Error("mode must be bass_octave_down, top_octave_up, or outer_octaves");
  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds), starts = new Set(selected.map(note => note.start));
  if (clip.notes.some(note => starts.has(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("chord doubling requires every note at each selected complete onset");

  const newNotes = [];
  for (const start of [...starts].sort((left, right) => left - right)) {
    const chord = selected.filter(note => note.start === start)
      .sort((left, right) => left.pitch - right.pitch || left.noteId - right.noteId);
    if (chord.length < 2) throw new Error("each doubled onset must contain at least two notes");
    const sources = options.mode === "bass_octave_down" ? [[chord[0], -12]] :
      options.mode === "top_octave_up" ? [[chord.at(-1), 12]] : [[chord[0], -12], [chord.at(-1), 12]];
    for (const [source, offset] of sources) {
      const pitch = source.pitch + offset;
      if (pitch < 0 || pitch > 127) throw new Error("chord doubling would exceed the MIDI pitch range");
      const generated = duplicate(source, pitch);
      if (clip.notes.some(existing => existing.pitch === pitch && overlaps(existing, generated)) ||
          newNotes.some(existing => existing.pitch === pitch && overlaps(existing, generated)))
        throw new Error("chord doubling would create a same-pitch collision");
      newNotes.push(generated);
    }
  }
  if (clip.notes.length + newNotes.length > MAX_NOTES)
    throw new Error("chord doubling supports at most 4096 final notes");
  return { noteIds: [...options.noteIds], mode: options.mode, newNotes, preservedNotes: clip.notes };
}

export function matchMidiChordDoublingReadback(plan, observedMutation, finalNotes) {
  if (!Array.isArray(finalNotes) || !Array.isArray(observedMutation?.removedNoteIds) ||
      observedMutation.removedNoteIds.length !== 0 || !Array.isArray(observedMutation.addedNoteIds) ||
      observedMutation.addedNoteIds.length !== plan.newNotes.length ||
      new Set(observedMutation.addedNoteIds).size !== plan.newNotes.length ||
      finalNotes.length !== plan.preservedNotes.length + plan.newNotes.length) return false;
  const byId = new Map(finalNotes.map(note => [note.noteId, note]));
  if (byId.size !== finalNotes.length || plan.preservedNotes.some(expected => {
    const actual = byId.get(expected.noteId);
    return !actual || !sameNoteShape(expected, actual);
  })) return false;
  const added = observedMutation.addedNoteIds.map(noteId => byId.get(noteId));
  if (added.some(note => !note)) return false;
  const unmatched = [...added];
  return plan.newNotes.every(expected => {
    const index = unmatched.findIndex(actual => sameNoteShape(expected, actual));
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  }) && unmatched.length === 0;
}
