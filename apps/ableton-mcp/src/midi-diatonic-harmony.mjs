import { getLiveScaleReference } from "./live-scale-reference.mjs";
import { matchMidiChordDoublingReadback } from "./midi-chord-doubling.mjs";

const EPSILON = 2e-7;
const MAX_NOTES = 4096;
const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

function overlaps(left, right) {
  return left.start < right.start + right.duration - EPSILON &&
    right.start < left.start + left.duration - EPSILON;
}

function duplicate(source, degreeOffset, pitch) {
  return { sourceNoteId: source.noteId, degreeOffset, pitch, start: source.start, duration: source.duration,
    velocity: source.velocity, velocityDeviation: source.velocityDeviation,
    releaseVelocity: source.releaseVelocity, probability: source.probability, mute: source.mute };
}

export function planMidiDiatonicHarmony(clip, key, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0 ||
      clip.notes.length > MAX_NOTES || new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("complete MIDI clip notes, length, and unique note IDs are required");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!Array.isArray(options.degreeOffsets) || !options.degreeOffsets.length || options.degreeOffsets.length > 16 ||
      new Set(options.degreeOffsets).size !== options.degreeOffsets.length ||
      options.degreeOffsets.some(offset => !Number.isInteger(offset) || offset === 0 || offset < -127 || offset > 127))
    throw new Error("degreeOffsets must contain 1 to 16 unique non-zero integers from -127 through 127");
  const reference = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(reference.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  const byId = new Map(clip.notes.map(current => [current.noteId, current]));
  const degreeCount = reference.intervals.length;
  const newNotes = [];
  for (const noteId of options.noteIds) {
    const source = byId.get(noteId);
    if (!source) throw new Error(`unknown noteId ${noteId}`);
    const delta = source.pitch - reference.rootNote;
    const octave = Math.floor(delta / 12);
    const interval = modulo(delta, 12);
    const degreeIndex = reference.intervals.indexOf(interval);
    if (degreeIndex < 0) throw new Error(`noteId ${noteId} is not in the current scale`);
    for (const degreeOffset of options.degreeOffsets) {
      const targetIndex = octave * degreeCount + degreeIndex + degreeOffset;
      const pitch = reference.rootNote + Math.floor(targetIndex / degreeCount) * 12 +
        reference.intervals[modulo(targetIndex, degreeCount)];
      if (pitch < 0 || pitch > 127) throw new Error("diatonic harmony would exceed the MIDI range");
      const generated = duplicate(source, degreeOffset, pitch);
      if (clip.notes.some(existing => existing.pitch === pitch && overlaps(existing, generated)) ||
          newNotes.some(existing => existing.pitch === pitch && overlaps(existing, generated)))
        throw new Error("diatonic harmony would create a same-pitch collision");
      newNotes.push(generated);
    }
  }
  if (clip.notes.length + newNotes.length > MAX_NOTES)
    throw new Error("diatonic harmony supports at most 4096 final notes");
  return { noteIds: [...options.noteIds], degreeOffsets: [...options.degreeOffsets],
    scale: { rootNote: reference.rootNote, scaleName: reference.name, scaleIntervals: [...reference.intervals] },
    newNotes, preservedNotes: clip.notes };
}

export function matchMidiDiatonicHarmonyReadback(plan, observedMutation, finalNotes) {
  return matchMidiChordDoublingReadback(plan, observedMutation, finalNotes);
}
