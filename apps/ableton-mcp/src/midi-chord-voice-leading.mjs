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

function octaveCandidates(pitch, minPitch, maxPitch) {
  const pitchClass = ((pitch % 12) + 12) % 12;
  const values = [];
  for (let candidate = pitchClass; candidate <= 127; candidate += 12)
    if (candidate >= minPitch && candidate <= maxPitch) values.push(candidate);
  return values;
}

function better(left, right) {
  if (!right) return true;
  if (left.movement !== right.movement) return left.movement < right.movement;
  if (left.displacement !== right.displacement) return left.displacement < right.displacement;
  return left.pitches.join(",") < right.pitches.join(",");
}

function leadChord(chord, previousPitches, mode, minPitch, maxPitch) {
  let states = [{ movement: 0, displacement: 0, pitches: [] }];
  chord.forEach((note, index) => {
    const candidates = mode === "preserve_bass" && index === 0 ? [note.pitch] :
      octaveCandidates(note.pitch, minPitch, maxPitch);
    if (!candidates.length) throw new Error("chord voice leading cannot fit within the requested MIDI pitch range");
    const next = [];
    for (const candidate of candidates) {
      let selected = null;
      for (const state of states) {
        if (state.pitches.length && candidate <= state.pitches.at(-1)) continue;
        const proposal = {
          movement: state.movement + Math.abs(candidate - previousPitches[index]),
          displacement: state.displacement + Math.abs(candidate - note.pitch),
          pitches: [...state.pitches, candidate],
        };
        if (better(proposal, selected)) selected = proposal;
      }
      if (selected) next.push(selected);
    }
    states = next;
  });
  if (!states.length) throw new Error("chord voice leading cannot preserve voice order within the requested MIDI pitch range");
  return states.reduce((best, state) => better(state, best) ? state : best, null);
}

export function planMidiChordVoiceLeading(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!["all_voices", "preserve_bass"].includes(options.mode))
    throw new Error("mode must be all_voices or preserve_bass");
  if (!Number.isInteger(options.minPitch) || !Number.isInteger(options.maxPitch) ||
      options.minPitch < 0 || options.maxPitch > 127 || options.minPitch > options.maxPitch)
    throw new Error("minPitch and maxPitch must define an ordered MIDI range from 0 to 127");

  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds), starts = new Set(selected.map(note => note.start));
  if (clip.notes.some(note => starts.has(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("chord voice leading requires every note at each selected complete onset");
  const chords = [...starts].sort((left, right) => left - right).map(start =>
    selected.filter(note => note.start === start).sort((left, right) => left.pitch - right.pitch || left.noteId - right.noteId));
  if (chords.length < 2) throw new Error("chord voice leading requires at least two chord onsets");
  if (chords[0].length < 2 || chords.some(chord => chord.length !== chords[0].length))
    throw new Error("every selected chord onset must contain the same number of voices and at least two notes");
  if (chords[0].some(note => note.pitch < options.minPitch || note.pitch > options.maxPitch))
    throw new Error("the anchored first chord must fit within the requested MIDI pitch range");

  const changes = chords[0].map(previous => ({ noteId: previous.noteId, previous, pitch: previous.pitch }));
  let previousPitches = chords[0].map(note => note.pitch);
  let totalMovementSemitones = 0;
  for (const chord of chords.slice(1)) {
    const led = leadChord(chord, previousPitches, options.mode, options.minPitch, options.maxPitch);
    totalMovementSemitones += led.movement;
    chord.forEach((previous, index) => changes.push({ noteId: previous.noteId, previous, pitch: led.pitches[index] }));
    previousPitches = led.pitches;
  }

  const changed = new Map(changes.map(change => [change.noteId, change.pitch]));
  const after = clip.notes.map(current => ({ ...current, pitch: changed.get(current.noteId) ?? current.pitch }));
  const beforePairs = collisions(clip.notes);
  if ([...collisions(after)].some(pair => !beforePairs.has(pair)))
    throw new Error("chord voice leading would create a same-pitch collision");
  return { noteIds: [...options.noteIds], mode: options.mode, minPitch: options.minPitch,
    maxPitch: options.maxPitch, totalMovementSemitones, changes };
}

export function matchMidiChordVoiceLeadingReadback(beforeNotes, changes, observedNotes) {
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
