import { getLiveScaleReference } from "./live-scale-reference.mjs";

const EPSILON = 2e-7;
const MAX_NOTES = 4096;
const SCALE_VOICES = { triad: 3, seventh: 4, ninth: 5 };
const CHROMATIC_INTERVALS = {
  sus2: [0, 2, 7], sus4: [0, 5, 7], add6: [0, 4, 7, 9], add9: [0, 4, 7, 14],
  dominant7: [0, 4, 7, 10], dominant9: [0, 4, 7, 10, 14],
  dominant7_b9: [0, 4, 7, 10, 13], dominant7_sharp9: [0, 4, 7, 10, 15],
  dominant7_sharp11: [0, 4, 7, 10, 18], dominant7_b13: [0, 4, 7, 10, 20],
  dominant13: [0, 4, 7, 10, 14, 21],
};

function overlaps(left, right) {
  return left.start < right.start + right.duration - EPSILON &&
    right.start < left.start + left.duration - EPSILON;
}

function sameShape(left, right) {
  return ["pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"]
    .every(field => left[field] === right[field]) &&
    Math.abs(left.start - right.start) <= EPSILON && Math.abs(left.duration - right.duration) <= EPSILON;
}

function nearestPitchForClass(pitchClass, anchor) {
  return Array.from({ length: Math.floor((127 - pitchClass) / 12) + 1 }, (_, index) => pitchClass + index * 12)
    .sort((left, right) => Math.abs(left - anchor) - Math.abs(right - anchor) || left - right)[0];
}

export function planMidiDiatonicChordQuality(clip, key, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0 ||
      clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("complete MIDI clip notes, length, and unique note IDs are required");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!Array.isArray(options.rootDegrees) || !options.rootDegrees.length ||
      options.rootDegrees.some(degree => !Number.isInteger(degree)))
    throw new Error("rootDegrees must contain integer scale degrees");
  if (!Object.hasOwn(SCALE_VOICES, options.chordSize) && !Object.hasOwn(CHROMATIC_INTERVALS, options.chordSize))
    throw new Error("chordSize is not a supported chord voicing");
  if (!["preserve_register", "voice_leading"].includes(options.mode))
    throw new Error("mode must be preserve_register or voice_leading");
  const reference = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(reference.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  if (options.rootDegrees.some(degree => degree < 1 || degree > reference.intervals.length))
    throw new Error(`rootDegrees must be between 1 and ${reference.intervals.length}`);
  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds);
  const starts = [...new Set(selected.map(note => note.start))].sort((left, right) => left - right);
  if (clip.notes.some(note => starts.includes(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("diatonic chord quality requires every note at each selected complete onset");
  if (options.rootDegrees.length !== starts.length)
    throw new Error("diatonic chord quality requires one root degree per onset");

  const voiceCount = SCALE_VOICES[options.chordSize] ?? CHROMATIC_INTERVALS[options.chordSize].length;
  const changes = [], removeNoteIds = [], newNotes = [], onsets = [];
  let previousTargetRoot = null;
  starts.forEach((start, onsetIndex) => {
    const chord = selected.filter(note => note.start === start)
      .sort((left, right) => left.pitch - right.pitch || left.noteId - right.noteId);
    if (chord.length < 2) throw new Error("each rebuilt onset must contain at least two source notes");
    const rootDegree = options.rootDegrees[onsetIndex];
    const rootPitchClass = (reference.rootNote + reference.intervals[rootDegree - 1]) % 12;
    const anchor = options.mode === "voice_leading" && previousTargetRoot !== null ? previousTargetRoot : chord[0].pitch;
    const targetRootPitch = nearestPitchForClass(rootPitchClass, anchor);
    const targetPitches = Object.hasOwn(CHROMATIC_INTERVALS, options.chordSize)
      ? CHROMATIC_INTERVALS[options.chordSize].map(interval => targetRootPitch + interval)
      : Array.from({ length: voiceCount }, (_, voice) => {
        const rootOctave = Math.floor((targetRootPitch - reference.rootNote) / 12);
        const scaleIndex = rootOctave * reference.intervals.length + rootDegree - 1 + voice * 2;
        const octave = Math.floor(scaleIndex / reference.intervals.length);
        const degreeIndex = ((scaleIndex % reference.intervals.length) + reference.intervals.length) % reference.intervals.length;
        return reference.rootNote + octave * 12 + reference.intervals[degreeIndex];
      });
    if (targetPitches.some(pitch => pitch < 0 || pitch > 127))
      throw new Error("diatonic chord quality would exceed the MIDI range");
    const retainedCount = Math.min(chord.length, voiceCount);
    for (let voice = 0; voice < retainedCount; voice += 1)
      changes.push({ noteId: chord[voice].noteId, previous: chord[voice], pitch: targetPitches[voice], chordToneIndex: voice });
    removeNoteIds.push(...chord.slice(voiceCount).map(note => note.noteId));
    const source = chord[Math.min(chord.length, voiceCount) - 1];
    for (let voice = chord.length; voice < voiceCount; voice += 1) {
      newNotes.push({ sourceNoteId: source.noteId, chordToneIndex: voice, pitch: targetPitches[voice],
        start: source.start, duration: source.duration, velocity: source.velocity,
        velocityDeviation: source.velocityDeviation, releaseVelocity: source.releaseVelocity,
        probability: source.probability, mute: source.mute });
    }
    onsets.push({ start, rootDegree, targetRootPitch, sourceNoteIds: chord.map(note => note.noteId), targetPitches });
    previousTargetRoot = targetRootPitch;
  });
  const changeById = new Map(changes.map(change => [change.noteId, change]));
  const removed = new Set(removeNoteIds);
  const projected = clip.notes.filter(note => !removed.has(note.noteId))
    .map(note => ({ ...note, pitch: changeById.get(note.noteId)?.pitch ?? note.pitch }))
    .concat(newNotes);
  for (let left = 0; left < projected.length; left += 1) for (let right = left + 1; right < projected.length; right += 1) {
    if (projected[left].pitch === projected[right].pitch && overlaps(projected[left], projected[right]))
      throw new Error("diatonic chord quality would create a same-pitch collision");
  }
  if (projected.length > MAX_NOTES) throw new Error("diatonic chord quality supports at most 4096 final notes");
  return { noteIds: [...options.noteIds], rootDegrees: [...options.rootDegrees], chordSize: options.chordSize,
    mode: options.mode, scale: { rootNote: reference.rootNote, scaleName: reference.name,
      scaleIntervals: [...reference.intervals] }, onsets, changes, removeNoteIds, newNotes, beforeNotes: clip.notes };
}

export function matchMidiDiatonicChordQualityReadback(plan, observedMutation, finalNotes) {
  if (!Array.isArray(finalNotes) || JSON.stringify(observedMutation?.removedNoteIds) !== JSON.stringify(plan.removeNoteIds) ||
      !Array.isArray(observedMutation?.addedNoteIds) || observedMutation.addedNoteIds.length !== plan.newNotes.length ||
      new Set(observedMutation.addedNoteIds).size !== plan.newNotes.length) return false;
  const byId = new Map(finalNotes.map(note => [note.noteId, note]));
  if (byId.size !== finalNotes.length || finalNotes.length !== plan.beforeNotes.length - plan.removeNoteIds.length + plan.newNotes.length)
    return false;
  const removed = new Set(plan.removeNoteIds), changes = new Map(plan.changes.map(change => [change.noteId, change]));
  for (const before of plan.beforeNotes) {
    const actual = byId.get(before.noteId);
    if (removed.has(before.noteId)) { if (actual) return false; continue; }
    const expected = changes.has(before.noteId) ? { ...before, pitch: changes.get(before.noteId).pitch } : before;
    if (!actual || !sameShape(expected, actual)) return false;
  }
  const added = observedMutation.addedNoteIds.map(noteId => byId.get(noteId));
  return added.every((actual, index) => actual && sameShape(plan.newNotes[index], actual));
}
