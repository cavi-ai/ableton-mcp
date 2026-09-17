import { getLiveScaleReference } from "./live-scale-reference.mjs";

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
}

export function planScaleMelody(key, reference, options) {
  const scale = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(scale.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  const selected = reference?.grids?.[options?.grid];
  if (!selected) throw new Error("unknown melody grid");
  if (!selected.barBoundaryOnGrid || !Number.isInteger(selected.stepsPerBar))
    throw new Error("melody grid must land on every bar boundary in the current time signature");
  integer(options.motifBars, "motifBars", 1, 16);
  integer(options.repeats, "repeats", 1, 16);
  if (!Number.isFinite(options.gate) || options.gate <= 0 || options.gate > 1)
    throw new Error("gate must be greater than zero and at most one");
  integer(options.velocity, "velocity", 1, 127);
  integer(options.basePitch, "basePitch", 0, 127);
  integer(options.minPitch, "minPitch", 0, 127);
  integer(options.maxPitch, "maxPitch", 0, 127);
  if (options.minPitch > options.maxPitch) throw new Error("minPitch must not exceed maxPitch");
  if (options.basePitch < options.minPitch || options.basePitch > options.maxPitch ||
      options.basePitch % 12 !== key.rootNote)
    throw new Error("basePitch must be the scale root pitch class inside the requested MIDI range");
  if (!Array.isArray(options.events) || options.events.length === 0)
    throw new Error("events must be a non-empty array");
  const stepsPerMotif = options.motifBars * selected.stepsPerBar;
  const seenSteps = new Set();
  const motif = options.events.map((event, index) => {
    integer(event?.step, `events[${index}].step`, 0, stepsPerMotif - 1);
    if (seenSteps.has(event.step)) throw new Error("melody event steps must be unique");
    seenSteps.add(event.step);
    integer(event.degree, `events[${index}].degree`, 1, 9);
    const octaveOffset = event.octaveOffset === undefined ? 0 : event.octaveOffset;
    integer(octaveOffset, `events[${index}].octaveOffset`, -4, 4);
    const velocity = event.velocity === undefined ? options.velocity : event.velocity;
    integer(velocity, `events[${index}].velocity`, 1, 127);
    const degreeIndex = event.degree - 1;
    const scaleIndex = degreeIndex % scale.intervals.length;
    const pitch = options.basePitch + scale.intervals[scaleIndex] +
      12 * (Math.floor(degreeIndex / scale.intervals.length) + octaveOffset);
    if (pitch < options.minPitch || pitch > options.maxPitch || pitch < 0 || pitch > 127)
      throw new Error(`events[${index}] pitch is outside the requested MIDI range`);
    return { step: event.step, degree: event.degree, octaveOffset, velocity, pitch,
      pitchClass: pitch % 12, noteName: scale.noteNames[scaleIndex] };
  }).toSorted((left, right) => left.step - right.step);
  if (motif.length * options.repeats > 4096)
    throw new Error("melody may generate at most 4096 MIDI notes");
  const stepBeats = 1 / selected.stepsPerQuarter;
  const motifLengthBeats = options.motifBars * reference.barLengthBeats;
  const duration = stepBeats * options.gate;
  const lengthBeats = motifLengthBeats * options.repeats;
  const notes = Array.from({ length: options.repeats }, (_, repeat) => motif.map(event => ({
    pitch: event.pitch,
    start: repeat * motifLengthBeats + event.step * stepBeats,
    duration,
    velocity: event.velocity,
    mute: false
  }))).flat();
  if (![stepBeats, motifLengthBeats, duration, lengthBeats].every(Number.isFinite) ||
      notes.some(note => !Number.isFinite(note.start)))
    throw new Error("derived melody timing must be finite");
  return { scale, grid: options.grid, motifBars: options.motifBars, repeats: options.repeats,
    gate: options.gate, velocity: options.velocity, basePitch: options.basePitch,
    minPitch: options.minPitch, maxPitch: options.maxPitch,
    stepsPerMotif, stepBeats, motifLengthBeats, motif, notes, lengthBeats };
}
