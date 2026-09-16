import { getLiveScaleReference } from "./live-scale-reference.mjs";

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
}

function lowestPitch(pitchClass, minPitch, maxPitch, maximumOffset) {
  const pitch = minPitch + (pitchClass - minPitch % 12 + 12) % 12;
  if (pitch + maximumOffset > maxPitch) throw new Error("bass pitch pattern cannot fit within the requested MIDI range");
  return pitch;
}

export function planScaleBassline(key, options) {
  const scale = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(scale.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  if (!Array.isArray(options?.degrees) || options.degrees.length === 0)
    throw new Error("degrees must be a non-empty array");
  if (!Number.isFinite(options.startBeats) || options.startBeats < 0) throw new Error("startBeats must be nonnegative");
  if (!Number.isFinite(options.chordBeats) || options.chordBeats <= 0) throw new Error("chordBeats must be positive");
  if (!Number.isFinite(options.stepBeats) || options.stepBeats <= 0) throw new Error("stepBeats must be positive");
  const stepsPerChord = Math.round(options.chordBeats / options.stepBeats);
  if (stepsPerChord < 1 || Math.abs(stepsPerChord * options.stepBeats - options.chordBeats) > 1e-9)
    throw new Error("stepBeats must divide chordBeats exactly");
  if (!Array.isArray(options.activeSteps) || options.activeSteps.length === 0)
    throw new Error("activeSteps must be a non-empty array");
  if (!options.activeSteps.every(Number.isInteger)) throw new Error("activeSteps must contain only integers");
  if (new Set(options.activeSteps).size !== options.activeSteps.length) throw new Error("activeSteps must be unique");
  if (!options.activeSteps.every(step => step >= 0 && step < stepsPerChord))
    throw new Error("activeSteps must fall within each chord");
  if (!Number.isFinite(options.gate) || options.gate <= 0 || options.gate > 1)
    throw new Error("gate must be greater than zero and at most one");
  requireInteger(options.velocity, "velocity", 1, 127);
  requireInteger(options.minPitch, "minPitch", 0, 127);
  requireInteger(options.maxPitch, "maxPitch", 0, 127);
  if (options.minPitch > options.maxPitch) throw new Error("minPitch must not exceed maxPitch");
  if (!["root", "root_octave", "root_fifth"].includes(options.pitchPattern))
    throw new Error("pitchPattern must be root, root_octave, or root_fifth");
  if (options.degrees.length * options.activeSteps.length > 4096)
    throw new Error("bassline may generate at most 4096 MIDI notes");

  const harmony = options.degrees.map((degree, chordIndex) => {
    requireInteger(degree, `degrees[${chordIndex}]`, 1, scale.intervals.length);
    const rootIndex = degree - 1;
    const rootPitchClass = scale.pitchClasses[rootIndex];
    const fifthPitchClass = scale.pitchClasses[(rootIndex + 4) % scale.intervals.length];
    const fifthOffset = (fifthPitchClass - rootPitchClass + 12) % 12;
    const patternOffsets = options.pitchPattern === "root" ? [0] :
      options.pitchPattern === "root_octave" ? [0, 12] : [0, fifthOffset];
    const rootPitch = lowestPitch(rootPitchClass, options.minPitch, options.maxPitch, Math.max(...patternOffsets));
    return { index: chordIndex, degree, rootPitchClass, rootName: scale.noteNames[rootIndex],
      fifthPitchClass, fifthName: scale.noteNames[(rootIndex + 4) % scale.intervals.length], rootPitch, patternOffsets };
  });
  const activeSteps = options.activeSteps.toSorted((a, b) => a - b);
  const duration = options.stepBeats * options.gate;
  const lengthBeats = options.startBeats + options.degrees.length * options.chordBeats;
  const notes = harmony.flatMap((chord, chordIndex) => activeSteps.map((step, eventIndex) => ({
    pitch: chord.rootPitch + chord.patternOffsets[eventIndex % chord.patternOffsets.length],
    start: options.startBeats + chordIndex * options.chordBeats + step * options.stepBeats,
    duration,
    velocity: options.velocity,
    mute: false
  })));
  if (!Number.isFinite(lengthBeats) || !Number.isFinite(duration) ||
      notes.some(note => !Number.isFinite(note.start)))
    throw new Error("derived bassline timing must be finite");
  return { scale, pitchPattern: options.pitchPattern, stepsPerChord, activeSteps, harmony, notes,
    lengthBeats };
}
