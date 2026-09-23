import { analyzeMidiChordEvents } from "./midi-chord-analysis.mjs";
import { getLiveScaleReference } from "./live-scale-reference.mjs";

const SCALE_RECIPES = { triad: 3, seventh: 4, ninth: 5 };
const CHROMATIC_RECIPES = {
  dominant7: [0, 4, 7, 10],
  dominant9: [0, 4, 7, 10, 14],
  dominant7_b9: [0, 4, 7, 10, 13],
  dominant7_sharp9: [0, 4, 7, 10, 15],
  dominant7_sharp11: [0, 4, 7, 10, 18],
  dominant7_b13: [0, 4, 7, 10, 20],
  dominant13: [0, 4, 7, 10, 14, 21]
};
const HARMONIC_FUNCTIONS = new Set(["diatonic", "secondary_dominant", "borrowed_parallel_minor"]);
const PARALLEL_MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10];

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
}

function chordOffsets(intervals, degree, notesPerChord) {
  const rootIndex = degree - 1;
  const rootInterval = intervals[rootIndex];
  return Array.from({ length: notesPerChord }, (_, noteIndex) => {
    const scaleIndex = rootIndex + noteIndex * 2;
    const octave = Math.floor(scaleIndex / intervals.length);
    return intervals[scaleIndex % intervals.length] + octave * 12 - rootInterval;
  });
}

function voicings(rootPitchClass, offsets, minPitch, maxPitch, rootPositionOnly) {
  const results = [];
  const seen = new Set();
  for (let root = rootPitchClass; root <= 127; root += 12) {
    const rootPitches = offsets.map(offset => root + offset);
    for (let inversion = 0; inversion < offsets.length; inversion += 1) {
      if (rootPositionOnly && inversion > 0) break;
      const pitches = [...rootPitches.slice(inversion), ...rootPitches.slice(0, inversion).map(pitch => pitch + 12)];
      if (pitches[0] < minPitch || pitches.at(-1) > maxPitch) continue;
      const signature = pitches.join(",");
      if (seen.has(signature)) continue;
      seen.add(signature);
      results.push({ pitches, inversion });
    }
  }
  return results;
}

function movement(previous, pitches) {
  if (!previous) return 0;
  const shared = Math.min(previous.length, pitches.length);
  const paired = pitches.slice(0, shared).reduce((total, pitch, index) => total + Math.abs(pitch - previous[index]), 0);
  return paired + Math.abs(previous.length - pitches.length) * 12;
}

function selectVoicing(candidates, previous, minPitch, maxPitch) {
  const center = (minPitch + maxPitch) / 2;
  return candidates.toSorted((a, b) =>
    movement(previous, a.pitches) - movement(previous, b.pitches) ||
    (previous ? 0 : a.inversion - b.inversion) ||
    Math.abs(a.pitches.reduce((sum, pitch) => sum + pitch, 0) / a.pitches.length - center) -
      Math.abs(b.pitches.reduce((sum, pitch) => sum + pitch, 0) / b.pitches.length - center) ||
    a.inversion - b.inversion || a.pitches[0] - b.pitches[0]
  )[0];
}

function chordMetadata(pitches, key, rootPitchClass) {
  const notes = pitches.map((pitch, index) => ({ noteId: index + 1, pitch, start: 0, duration: 1, mute: false }));
  const candidates = analyzeMidiChordEvents(notes, key).events[0]?.candidates ?? [];
  return candidates.find(candidate => candidate.rootPitchClass === rootPitchClass) ?? null;
}

export function matchMidiNoteReadback(expectedNotes, observedNotes, tolerance = 1e-9) {
  if (!Array.isArray(expectedNotes) || !Array.isArray(observedNotes) || expectedNotes.length !== observedNotes.length)
    return false;
  const candidates = expectedNotes.map(expected => observedNotes.flatMap((actual, index) =>
    expected.pitch === actual.pitch &&
      expected.velocity === actual.velocity && expected.mute === actual.mute &&
      Math.abs(expected.start - actual.start) <= tolerance &&
      Math.abs(expected.duration - actual.duration) <= tolerance ? [index] : []));
  if (candidates.some(indices => indices.length === 0)) return false;
  const matchedExpected = Array(observedNotes.length).fill(-1);
  const assign = (expectedIndex, visited) => candidates[expectedIndex].some(observedIndex => {
    if (visited.has(observedIndex)) return false;
    visited.add(observedIndex);
    if (matchedExpected[observedIndex] !== -1 && !assign(matchedExpected[observedIndex], visited)) return false;
    matchedExpected[observedIndex] = expectedIndex;
    return true;
  });
  return candidates.map((indices, index) => ({ index, choices: indices.length }))
    .toSorted((a, b) => a.choices - b.choices)
    .every(({ index }) => assign(index, new Set()));
}

function normalizeArticulation(articulation, chordBeats) {
  if (articulation === undefined) return { mode: "block", stepBeats: chordBeats, gate: 1, stepsPerChord: 1 };
  if (!articulation || typeof articulation !== "object" || Array.isArray(articulation))
    throw new Error("articulation must be an object");
  const { mode, stepBeats, gate } = articulation;
  if (!["block", "pulse", "arpeggio_up", "arpeggio_down"].includes(mode))
    throw new Error("articulation mode must be block, pulse, arpeggio_up, or arpeggio_down");
  if (mode === "block") {
    if (stepBeats !== undefined || gate !== undefined)
      throw new Error("block articulation does not accept stepBeats or gate");
    return { mode, stepBeats: chordBeats, gate: 1, stepsPerChord: 1 };
  }
  if (!Number.isFinite(stepBeats) || stepBeats <= 0) throw new Error("articulation stepBeats must be positive");
  if (!Number.isFinite(gate) || gate <= 0 || gate > 1) throw new Error("articulation gate must be greater than zero and at most one");
  const stepsPerChord = Math.round(chordBeats / stepBeats);
  if (stepsPerChord < 1 || Math.abs(stepsPerChord * stepBeats - chordBeats) > 1e-9)
    throw new Error("articulation stepBeats must divide chordBeats exactly");
  return { mode, stepBeats, gate, stepsPerChord };
}

function articulateChords(chords, options, articulation) {
  return chords.flatMap((chord, chordIndex) => {
    const chordStart = options.startBeats + chordIndex * options.chordBeats;
    if (articulation.mode === "block") return chord.pitches.map(pitch => ({
      pitch, start: chordStart, duration: options.chordBeats, velocity: options.velocity, mute: false
    }));
    const pitches = articulation.mode === "arpeggio_down" ? chord.pitches.toReversed() : chord.pitches;
    return Array.from({ length: articulation.stepsPerChord }, (_, stepIndex) => {
      const eventPitches = articulation.mode === "pulse" ? pitches : [pitches[stepIndex % pitches.length]];
      return eventPitches.map(pitch => ({
        pitch,
        start: chordStart + stepIndex * articulation.stepBeats,
        duration: articulation.stepBeats * articulation.gate,
        velocity: options.velocity,
        mute: false
      }));
    }).flat();
  });
}

export function planScaleChordProgression(key, options) {
  const scale = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(scale.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  if (!Array.isArray(options?.degrees) || options.degrees.length === 0)
    throw new Error("degrees must be a non-empty array");
  requireInteger(options.notesPerChord, "notesPerChord", 3, 4);
  const chordRecipes = options.chordRecipes === undefined
    ? options.degrees.map(() => options.notesPerChord === 3 ? "triad" : "seventh")
    : options.chordRecipes;
  const harmonicFunctions = options.harmonicFunctions === undefined
    ? options.degrees.map(() => "diatonic")
    : options.harmonicFunctions;
  const bassDegrees = options.bassDegrees === undefined
    ? options.degrees.map(() => null)
    : options.bassDegrees;
  if (!Array.isArray(chordRecipes) || chordRecipes.length !== options.degrees.length)
    throw new Error("functional progression requires one chord recipe per degree");
  if (chordRecipes.some(recipe => !Object.hasOwn(SCALE_RECIPES, recipe) && !Object.hasOwn(CHROMATIC_RECIPES, recipe)))
    throw new Error("one or more chord recipes are not supported");
  if (!Array.isArray(harmonicFunctions) || harmonicFunctions.length !== options.degrees.length ||
      harmonicFunctions.some(harmonicFunction => !HARMONIC_FUNCTIONS.has(harmonicFunction)))
    throw new Error("functional progression requires one supported harmonic function per degree");
  if (!Array.isArray(bassDegrees) || bassDegrees.length !== options.degrees.length ||
      bassDegrees.some(degree => degree !== null && (!Number.isInteger(degree) || degree < 1 || degree > scale.intervals.length)))
    throw new Error("functional progression requires one bass degree per chord");
  if (!Number.isFinite(options.startBeats) || options.startBeats < 0) throw new Error("startBeats must be nonnegative");
  if (!Number.isFinite(options.chordBeats) || options.chordBeats <= 0) throw new Error("chordBeats must be positive");
  requireInteger(options.velocity, "velocity", 1, 127);
  requireInteger(options.minPitch, "minPitch", 0, 127);
  requireInteger(options.maxPitch, "maxPitch", 0, 127);
  if (options.minPitch > options.maxPitch) throw new Error("minPitch must not exceed maxPitch");
  if (!["closest", "root_position"].includes(options.voiceLeading))
    throw new Error("voiceLeading must be closest or root_position");
  const articulation = normalizeArticulation(options.articulation, options.chordBeats);
  const voicesPerChord = chordRecipes.map((recipe, index) =>
    (SCALE_RECIPES[recipe] ?? CHROMATIC_RECIPES[recipe].length) + (bassDegrees[index] === null ? 0 : 1));
  const noteCount = articulation.stepsPerChord * (articulation.mode === "pulse" || articulation.mode === "block"
    ? voicesPerChord.reduce((total, voices) => total + voices, 0)
    : options.degrees.length);
  if (noteCount > 4096) throw new Error("articulation may generate at most 4096 MIDI notes");

  let previous = null;
  const chords = options.degrees.map((degree, chordIndex) => {
    requireInteger(degree, `degrees[${chordIndex}]`, 1, scale.intervals.length);
    const recipe = chordRecipes[chordIndex];
    const harmonicFunction = harmonicFunctions[chordIndex];
    if (harmonicFunction === "secondary_dominant" && !recipe.startsWith("dominant"))
      throw new Error("secondary dominant requires a dominant recipe");
    if (harmonicFunction === "borrowed_parallel_minor" && !Object.hasOwn(SCALE_RECIPES, recipe))
      throw new Error("borrowed harmony requires a scale-stacked recipe");
    const functionIntervals = harmonicFunction === "borrowed_parallel_minor" ? PARALLEL_MINOR_INTERVALS : scale.intervals;
    const targetPitchClass = (scale.rootNote + functionIntervals[degree - 1]) % 12;
    const rootPitchClass = harmonicFunction === "secondary_dominant" ? (targetPitchClass + 7) % 12 : targetPitchClass;
    const offsets = Object.hasOwn(CHROMATIC_RECIPES, recipe)
      ? CHROMATIC_RECIPES[recipe]
      : chordOffsets(functionIntervals, degree, SCALE_RECIPES[recipe]);
    const candidates = voicings(rootPitchClass, offsets,
      options.minPitch, options.maxPitch, options.voiceLeading === "root_position");
    if (candidates.length === 0)
      throw new Error(`degree ${degree} chord cannot fit within the requested MIDI range`);
    const selected = selectVoicing(candidates, previous, options.minPitch, options.maxPitch);
    const movementSemitones = movement(previous, selected.pitches);
    const metadata = chordMetadata(selected.pitches, key, rootPitchClass);
    const bassDegree = bassDegrees[chordIndex];
    const bassPitchClass = bassDegree === null ? null :
      (scale.rootNote + scale.intervals[bassDegree - 1]) % 12;
    const targetBassPitch = bassPitchClass === null ? null :
      Array.from({ length: Math.floor((127 - bassPitchClass) / 12) + 1 }, (_, index) => bassPitchClass + index * 12)
        .filter(pitch => pitch >= options.minPitch && pitch < selected.pitches[0]).at(-1);
    if (bassDegree !== null && targetBassPitch === undefined)
      throw new Error("functional progression bass cannot fit below its chord within the requested MIDI range");
    const pitches = targetBassPitch === null ? selected.pitches : [targetBassPitch, ...selected.pitches];
    previous = selected.pitches;
    return {
      index: chordIndex,
      degree,
      recipe,
      harmonicFunction,
      bassDegree,
      targetBassPitch,
      degreeLabel: scale.intervals.length === 7 ? (metadata?.romanNumeral ?? `degree-${degree}`) : `degree-${degree}`,
      rootPitchClass,
      rootName: scale.noteNames[degree - 1],
      pitches,
      inversion: selected.inversion,
      movementSemitones,
      name: metadata?.name ?? null,
      symbol: metadata?.symbol ?? null,
      romanNumeral: scale.intervals.length === 7 ? (metadata?.romanNumeral ?? null) : null
    };
  });
  const notes = articulateChords(chords, options, articulation);
  return {
    scale,
    scaleSize: scale.intervals.length,
    voiceLeading: options.voiceLeading,
    notesPerChord: options.notesPerChord,
    startBeats: options.startBeats,
    chordBeats: options.chordBeats,
    velocity: options.velocity,
    minPitch: options.minPitch,
    maxPitch: options.maxPitch,
    chordRecipes,
    harmonicFunctions,
    bassDegrees,
    articulation,
    chords,
    notes,
    lengthBeats: options.startBeats + options.degrees.length * options.chordBeats,
    totalMovementSemitones: chords.reduce((total, chord) => total + chord.movementSemitones, 0)
  };
}
