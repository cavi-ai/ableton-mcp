import { getLiveScaleReference } from "./live-scale-reference.mjs";
import { matchMidiTranspositionReadback } from "./midi-transposition.mjs";

const EPSILON = 2e-7;
const MAX_NOTES = 4096;

function overlaps(left, right) {
  return left.start < right.start + right.duration - EPSILON &&
    right.start < left.start + left.duration - EPSILON;
}

function nearestPitchForClass(pitchClass, anchor) {
  const candidates = [];
  for (let pitch = pitchClass; pitch <= 127; pitch += 12) candidates.push(pitch);
  return candidates.sort((left, right) => Math.abs(left - anchor) - Math.abs(right - anchor) || left - right)[0];
}

export function planMidiScaleChordRemapping(clip, key, options) {
  if (!Array.isArray(clip?.notes) || clip.notes.length > MAX_NOTES ||
      new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!Array.isArray(options.targetDegrees) || !options.targetDegrees.length ||
      options.targetDegrees.some(degree => !Number.isInteger(degree)))
    throw new Error("targetDegrees must contain integer scale degrees");
  if (!["preserve_register", "voice_leading"].includes(options.mode))
    throw new Error("mode must be preserve_register or voice_leading");
  const reference = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(reference.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  if (options.targetDegrees.some(degree => degree < 1 || degree > reference.intervals.length))
    throw new Error(`targetDegrees must be between 1 and ${reference.intervals.length}`);
  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selected = options.noteIds.map(noteId => {
    const note = byId.get(noteId);
    if (!note) throw new Error(`unknown noteId ${noteId}`);
    return note;
  });
  const selectedIds = new Set(options.noteIds);
  const starts = [...new Set(selected.map(note => note.start))].sort((left, right) => left - right);
  if (clip.notes.some(note => starts.includes(note.start) && !selectedIds.has(note.noteId)))
    throw new Error("scale chord remapping requires every note at each selected complete onset");
  if (options.targetDegrees.length !== starts.length)
    throw new Error("scale chord remapping requires one target degree per onset");

  const changes = [], onsets = [];
  let previousTargetBass = null;
  starts.forEach((start, index) => {
    const chord = selected.filter(note => note.start === start)
      .sort((left, right) => left.pitch - right.pitch || left.noteId - right.noteId);
    if (chord.length < 2) throw new Error("each remapped onset must contain at least two notes");
    const sourceBassPitch = chord[0].pitch;
    const targetDegree = options.targetDegrees[index];
    const pitchClass = (reference.rootNote + reference.intervals[targetDegree - 1]) % 12;
    const anchor = options.mode === "voice_leading" && previousTargetBass !== null ? previousTargetBass : sourceBassPitch;
    const targetBassPitch = nearestPitchForClass(pitchClass, anchor);
    const semitones = targetBassPitch - sourceBassPitch;
    const onsetChanges = chord.map(previous => {
      const pitch = previous.pitch + semitones;
      if (pitch < 0 || pitch > 127) throw new Error("scale chord remapping would exceed the MIDI range");
      return { noteId: previous.noteId, previous, pitch };
    });
    changes.push(...onsetChanges);
    onsets.push({ start, targetDegree, sourceBassPitch, targetBassPitch, semitones,
      noteIds: chord.map(note => note.noteId) });
    previousTargetBass = targetBassPitch;
  });
  if (changes.every(change => change.pitch === change.previous.pitch))
    throw new Error("scale chord remapping would not change any notes");
  const changeById = new Map(changes.map(change => [change.noteId, change]));
  const projected = clip.notes.map(note => ({ ...note, pitch: changeById.get(note.noteId)?.pitch ?? note.pitch }));
  for (let left = 0; left < projected.length; left += 1) {
    for (let right = left + 1; right < projected.length; right += 1) {
      if (!changeById.has(projected[left].noteId) && !changeById.has(projected[right].noteId)) continue;
      if (projected[left].pitch === projected[right].pitch && overlaps(projected[left], projected[right]))
        throw new Error("scale chord remapping would create a same-pitch collision");
    }
  }
  return { noteIds: [...options.noteIds], targetDegrees: [...options.targetDegrees], mode: options.mode,
    scale: { rootNote: reference.rootNote, scaleName: reference.name, scaleIntervals: [...reference.intervals] },
    onsets, changes };
}

export function matchMidiScaleChordRemappingReadback(beforeNotes, plan, finalNotes) {
  return matchMidiTranspositionReadback(beforeNotes, plan, finalNotes);
}
