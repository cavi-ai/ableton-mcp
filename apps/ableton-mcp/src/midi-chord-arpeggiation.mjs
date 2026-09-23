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

function randomKey(pitch, seed) {
  let value = (pitch ^ seed) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function traversal(chord, mode, seed) {
  if (mode === "down") return [...chord].reverse();
  if (mode === "up_down") return [...chord, ...chord.slice(1, -1).reverse()];
  if (mode === "random") return [...chord].sort((left, right) =>
    randomKey(left.pitch, seed) - randomKey(right.pitch, seed) || left.pitch - right.pitch);
  return chord;
}

function replacement(source, start, duration) {
  return { sourceNoteId: source.noteId, pitch: source.pitch, start, duration,
    velocity: source.velocity, velocityDeviation: source.velocityDeviation,
    releaseVelocity: source.releaseVelocity, probability: source.probability, mute: source.mute };
}

export function planMidiChordArpeggiation(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!["up", "down", "up_down", "random"].includes(options.mode))
    throw new Error("mode must be up, down, up_down, or random");
  if (!Number.isFinite(options.stepBeats) || options.stepBeats <= 0)
    throw new Error("stepBeats must be greater than zero");
  if (!Number.isFinite(options.gate) || options.gate <= 0 || options.gate > 1)
    throw new Error("gate must be greater than zero and at most one");
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0x7fffffff)
    throw new Error("seed must be an integer from 0 through 2147483647");

  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds), starts = new Set(selected.map(note => note.start));
  if (clip.notes.some(note => starts.has(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("chord arpeggiation requires every note at each selected complete onset");

  const onsetCounts = new Map();
  for (const current of clip.notes) onsetCounts.set(current.start, (onsetCounts.get(current.start) ?? 0) + 1);
  const chordOnsets = [...onsetCounts].filter(([, count]) => count >= 2).map(([start]) => start).sort((a, b) => a - b);
  const preservedNotes = clip.notes.filter(note => !selectedIds.has(note.noteId));
  const changes = [];
  const newNotes = [];
  for (const start of [...starts].sort((left, right) => left - right)) {
    const chord = selected.filter(note => note.start === start)
      .sort((left, right) => left.pitch - right.pitch || left.noteId - right.noteId);
    if (chord.length < 2) throw new Error("each arpeggiated onset must contain at least two notes");
    const ordered = traversal(chord, options.mode, options.seed);
    const nextOnset = chordOnsets.find(onset => onset > start + EPSILON) ?? clip.lengthBeats;
    const duration = options.stepBeats * options.gate;
    ordered.forEach((source, index) => {
      const generated = replacement(source, start + index * options.stepBeats, duration);
      if (generated.start + generated.duration > nextOnset + EPSILON)
        throw new Error("chord arpeggiation would cross the next chord or clip boundary");
      const priorGenerated = [
        ...changes.map(change => ({ ...change.previous, start: change.start, duration: change.duration })),
        ...newNotes,
      ];
      if (preservedNotes.some(existing => existing.pitch === generated.pitch && overlaps(existing, generated)) ||
          priorGenerated.some(existing => existing.pitch === generated.pitch && overlaps(existing, generated)))
        throw new Error("chord arpeggiation would create a same-pitch collision");
      if (index < chord.length) {
        changes.push({ noteId: source.noteId, previous: source, start: generated.start, duration: generated.duration });
      } else {
        newNotes.push(generated);
      }
    });
  }
  if (clip.notes.length + newNotes.length > MAX_NOTES)
    throw new Error("chord arpeggiation supports at most 4096 final notes");
  return { noteIds: [...options.noteIds], mode: options.mode, stepBeats: options.stepBeats,
    gate: options.gate, seed: options.seed, changes, newNotes };
}

export function matchMidiChordArpeggiationReadback(beforeNotes, plan, observedMutation, finalNotes) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(finalNotes) ||
      !Array.isArray(observedMutation?.addedNoteIds) ||
      observedMutation.addedNoteIds.length !== plan.newNotes.length ||
      new Set(observedMutation.addedNoteIds).size !== plan.newNotes.length ||
      finalNotes.length !== beforeNotes.length + plan.newNotes.length) return false;
  const byId = new Map(finalNotes.map(note => [note.noteId, note]));
  const changes = new Map(plan.changes.map(change => [change.noteId, change]));
  if (byId.size !== finalNotes.length || beforeNotes.some(original => {
    const change = changes.get(original.noteId);
    const expected = change ? { ...original, start: change.start, duration: change.duration } : original;
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
