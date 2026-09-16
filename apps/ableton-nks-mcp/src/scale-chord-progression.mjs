import { analyzeMidiChordEvents } from "./midi-chord-analysis.mjs";
import { getLiveScaleReference } from "./live-scale-reference.mjs";

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
}

function chordOffsets(scale, degree, notesPerChord) {
  const rootIndex = degree - 1;
  const rootInterval = scale.intervals[rootIndex];
  return Array.from({ length: notesPerChord }, (_, noteIndex) => {
    const scaleIndex = rootIndex + noteIndex * 2;
    const octave = Math.floor(scaleIndex / scale.intervals.length);
    return scale.intervals[scaleIndex % scale.intervals.length] + octave * 12 - rootInterval;
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
  return previous ? pitches.reduce((total, pitch, index) => total + Math.abs(pitch - previous[index]), 0) : 0;
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

export function planScaleChordProgression(key, options) {
  const scale = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(scale.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  if (!Array.isArray(options?.degrees) || options.degrees.length === 0)
    throw new Error("degrees must be a non-empty array");
  requireInteger(options.notesPerChord, "notesPerChord", 3, 4);
  if (!Number.isFinite(options.startBeats) || options.startBeats < 0) throw new Error("startBeats must be nonnegative");
  if (!Number.isFinite(options.chordBeats) || options.chordBeats <= 0) throw new Error("chordBeats must be positive");
  requireInteger(options.velocity, "velocity", 1, 127);
  requireInteger(options.minPitch, "minPitch", 0, 127);
  requireInteger(options.maxPitch, "maxPitch", 0, 127);
  if (options.minPitch > options.maxPitch) throw new Error("minPitch must not exceed maxPitch");
  if (!["closest", "root_position"].includes(options.voiceLeading))
    throw new Error("voiceLeading must be closest or root_position");

  let previous = null;
  const chords = options.degrees.map((degree, chordIndex) => {
    requireInteger(degree, `degrees[${chordIndex}]`, 1, scale.intervals.length);
    const rootPitchClass = scale.pitchClasses[degree - 1];
    const candidates = voicings(rootPitchClass, chordOffsets(scale, degree, options.notesPerChord),
      options.minPitch, options.maxPitch, options.voiceLeading === "root_position");
    if (candidates.length === 0)
      throw new Error(`degree ${degree} chord cannot fit within the requested MIDI range`);
    const selected = selectVoicing(candidates, previous, options.minPitch, options.maxPitch);
    const movementSemitones = movement(previous, selected.pitches);
    const metadata = chordMetadata(selected.pitches, key, rootPitchClass);
    previous = selected.pitches;
    return {
      index: chordIndex,
      degree,
      degreeLabel: scale.intervals.length === 7 ? (metadata?.romanNumeral ?? `degree-${degree}`) : `degree-${degree}`,
      rootPitchClass,
      rootName: scale.noteNames[degree - 1],
      pitches: selected.pitches,
      inversion: selected.inversion,
      movementSemitones,
      name: metadata?.name ?? null,
      symbol: metadata?.symbol ?? null,
      romanNumeral: scale.intervals.length === 7 ? (metadata?.romanNumeral ?? null) : null
    };
  });
  const notes = chords.flatMap((chord, chordIndex) => chord.pitches.map(pitch => ({
    pitch,
    start: options.startBeats + chordIndex * options.chordBeats,
    duration: options.chordBeats,
    velocity: options.velocity,
    mute: false
  })));
  return {
    scale,
    scaleSize: scale.intervals.length,
    voiceLeading: options.voiceLeading,
    notesPerChord: options.notesPerChord,
    chords,
    notes,
    lengthBeats: options.startBeats + options.degrees.length * options.chordBeats,
    totalMovementSemitones: chords.reduce((total, chord) => total + chord.movementSemitones, 0)
  };
}
