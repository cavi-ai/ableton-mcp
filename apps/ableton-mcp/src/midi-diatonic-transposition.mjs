import { getLiveScaleReference } from "./live-scale-reference.mjs";
import { matchMidiTranspositionReadback } from "./midi-transposition.mjs";

const EPSILON = 2e-7;
const MAX_NOTES = 4096;
const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

function overlaps(left, right) {
  return left.start < right.start + right.duration - EPSILON &&
    right.start < left.start + left.duration - EPSILON;
}

export function planMidiDiatonicTransposition(clip, key, options) {
  if (!Array.isArray(clip?.notes) || clip.notes.length > MAX_NOTES ||
      new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip must contain at most 4096 notes with unique note IDs");
  if (!Array.isArray(options?.noteIds) || !options.noteIds.length || options.noteIds.length > MAX_NOTES ||
      new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must contain 1 to 4096 unique note IDs");
  if (!Number.isInteger(options.scaleSteps) || options.scaleSteps < -127 ||
      options.scaleSteps > 127 || options.scaleSteps === 0)
    throw new Error("scaleSteps must be a non-zero integer from -127 through 127");
  const reference = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(reference.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");

  const byId = new Map(clip.notes.map(note => [note.noteId, note]));
  const selectedIds = new Set(options.noteIds);
  const degreeCount = reference.intervals.length;
  const changes = options.noteIds.map(noteId => {
    const previous = byId.get(noteId);
    if (!previous) throw new Error(`unknown noteId ${noteId}`);
    const delta = previous.pitch - reference.rootNote;
    const octave = Math.floor(delta / 12);
    const interval = modulo(delta, 12);
    const degreeIndex = reference.intervals.indexOf(interval);
    if (degreeIndex < 0) throw new Error(`noteId ${noteId} is not in the current scale`);
    const targetIndex = octave * degreeCount + degreeIndex + options.scaleSteps;
    const targetOctave = Math.floor(targetIndex / degreeCount);
    const targetDegree = modulo(targetIndex, degreeCount);
    const pitch = reference.rootNote + targetOctave * 12 + reference.intervals[targetDegree];
    if (pitch < 0 || pitch > 127) throw new Error("diatonic transposition would exceed the MIDI range");
    return { noteId, previous, pitch, degree: targetDegree + 1 };
  });
  const retained = clip.notes.filter(note => !selectedIds.has(note.noteId));
  for (const change of changes) {
    const candidate = { ...change.previous, pitch: change.pitch };
    if (retained.some(note => note.pitch === candidate.pitch && overlaps(note, candidate)))
      throw new Error("diatonic transposition would create a same-pitch collision");
  }
  return { noteIds: [...options.noteIds], scaleSteps: options.scaleSteps,
    scale: { rootNote: reference.rootNote, scaleName: reference.name, scaleIntervals: [...reference.intervals] },
    changes };
}

export function matchMidiDiatonicTranspositionReadback(beforeNotes, plan, finalNotes) {
  return matchMidiTranspositionReadback(beforeNotes, plan, finalNotes);
}
