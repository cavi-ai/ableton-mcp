const EPSILON = 2e-7;
const MAX_NOTES = 4096;

function overlaps(left, right) {
  return left.start < right.start + right.duration - EPSILON &&
    right.start < left.start + left.duration - EPSILON;
}

function sameNoteShape(left, right) {
  const exact = ["pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"];
  return exact.every(field => left[field] === right[field]) &&
    Math.abs(left.start - right.start) <= EPSILON &&
    Math.abs(left.duration - right.duration) <= EPSILON;
}

export function planMidiRatchetPattern(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || options.noteIds.length === 0 || options.noteIds.length > MAX_NOTES)
    throw new Error("noteIds must contain 1 to 4096 note IDs");
  if (new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must not contain a duplicate noteId");
  if (!Number.isFinite(options.spanBeats) || options.spanBeats <= 0 || options.spanBeats > 128)
    throw new Error("spanBeats must be greater than 0 and at most 128");
  if (!Array.isArray(options.repeatCounts) || options.repeatCounts.length === 0 || options.repeatCounts.length > 128 ||
      options.repeatCounts.some(count => !Number.isInteger(count) || count < 1 || count > 64))
    throw new Error("repeatCounts must contain 1 to 128 integers from 1 to 64");
  if (!Number.isFinite(options.gate) || options.gate <= 0 || options.gate > 1)
    throw new Error("gate must be greater than 0 and at most 1");

  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds);
  const selectedStarts = new Set(selected.map(note => note.start));
  if (clip.notes.some(note => selectedStarts.has(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("ratchet patterns require every note at each selected complete onset");

  const onsets = [...selectedStarts].sort((left, right) => left - right);
  const repeatByStart = new Map(onsets.map((start, index) => [
    start, options.repeatCounts[index % options.repeatCounts.length],
  ]));
  const newNotes = [];
  for (const source of selected) {
    const count = repeatByStart.get(source.start);
    const step = options.spanBeats / count;
    const duration = step * options.gate;
    for (let repeat = 0; repeat < count; repeat += 1) newNotes.push({
      sourceNoteId: source.noteId, pitch: source.pitch, start: source.start + step * repeat,
      duration, velocity: source.velocity, velocityDeviation: source.velocityDeviation,
      releaseVelocity: source.releaseVelocity, probability: source.probability, mute: source.mute,
    });
  }
  if (newNotes.some(note => note.start + note.duration > clip.lengthBeats + EPSILON))
    throw new Error("ratchet pattern would extend a note beyond the clip");
  const preservedNotes = clip.notes.filter(note => !selectedIds.has(note.noteId));
  if (preservedNotes.length + newNotes.length > MAX_NOTES)
    throw new Error("ratchet pattern supports at most 4096 final notes");
  for (const generated of newNotes) {
    if (preservedNotes.some(existing => existing.pitch === generated.pitch && overlaps(existing, generated)))
      throw new Error("ratchet pattern would create a same-pitch collision");
  }
  const unchanged = selected.length === newNotes.length && selected.every(source =>
    newNotes.some(generated => generated.sourceNoteId === source.noteId && sameNoteShape(source, generated)));
  if (unchanged) throw new Error("ratchet pattern would not change any selected notes");
  return { noteIds: [...options.noteIds], spanBeats: options.spanBeats,
    repeatCounts: [...options.repeatCounts], gate: options.gate,
    removeNoteIds: [...options.noteIds], newNotes, preservedNotes };
}

export function matchMidiRatchetReadback(plan, observedMutation, finalNotes) {
  if (!Array.isArray(finalNotes) || !Array.isArray(observedMutation?.removedNoteIds) ||
      !Array.isArray(observedMutation?.addedNoteIds) ||
      observedMutation.removedNoteIds.length !== plan.removeNoteIds.length ||
      observedMutation.addedNoteIds.length !== plan.newNotes.length ||
      new Set(observedMutation.addedNoteIds).size !== plan.newNotes.length ||
      finalNotes.length !== plan.preservedNotes.length + plan.newNotes.length) return false;
  if (plan.removeNoteIds.some(noteId => !observedMutation.removedNoteIds.includes(noteId))) return false;
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
