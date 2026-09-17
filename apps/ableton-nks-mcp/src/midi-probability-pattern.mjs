const EPSILON = 2e-7;

export function planMidiProbabilityPattern(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (new Set(clip.notes.map(current => current.noteId)).size !== clip.notes.length)
    throw new Error("clip notes must have unique note IDs");
  if (!Array.isArray(options?.noteIds) || options.noteIds.length === 0)
    throw new Error("noteIds must be a non-empty array");
  if (options.noteIds.length > 4096) throw new Error("noteIds supports at most 4096 notes");
  if (new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must not contain a duplicate noteId");
  if (!Array.isArray(options.probabilities) || options.probabilities.length === 0 ||
      options.probabilities.length > 128)
    throw new Error("probabilities must contain 1 to 128 values");
  options.probabilities.forEach((probability, index) => {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1)
      throw new Error(`probabilities[${index}] must be between 0 and 1`);
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
    throw new Error("probability patterns require every note at each selected complete onset");
  const onsets = [...selectedStarts].sort((left, right) => left - right);
  const probabilityByStart = new Map(onsets.map((start, index) => [
    start, options.probabilities[index % options.probabilities.length],
  ]));
  const changes = selected
    .map(previous => ({ noteId: previous.noteId, previous,
      probability: probabilityByStart.get(previous.start) }))
    .filter(change => Math.abs(change.probability - change.previous.probability) > EPSILON);
  if (changes.length === 0) throw new Error("probability pattern would not change any selected notes");
  return { noteIds: [...options.noteIds], probabilities: [...options.probabilities], changes };
}

export function matchMidiProbabilityPatternReadback(beforeNotes, changes, observedNotes, tolerance = EPSILON) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(changes) || !Array.isArray(observedNotes) ||
      beforeNotes.length !== observedNotes.length) return false;
  const expected = new Map(beforeNotes.map(current => [current.noteId, { ...current }]));
  if (expected.size !== beforeNotes.length) return false;
  for (const change of changes) {
    const current = expected.get(change.noteId);
    if (!current) return false;
    current.probability = change.probability;
  }
  if (new Set(observedNotes.map(current => current.noteId)).size !== expected.size ||
      observedNotes.some(current => !expected.has(current.noteId))) return false;
  const exactFields = ["pitch", "velocity", "velocityDeviation", "releaseVelocity", "mute"];
  return observedNotes.every(actual => {
    const wanted = expected.get(actual.noteId);
    return exactFields.every(field => wanted[field] === actual[field]) &&
      Math.abs(wanted.start - actual.start) <= tolerance &&
      Math.abs(wanted.duration - actual.duration) <= tolerance &&
      Math.abs(wanted.probability - actual.probability) <= tolerance;
  });
}
