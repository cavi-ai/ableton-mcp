import { getLiveScaleReference } from "./live-scale-reference.mjs";

const NOTE_NAMES = ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"];

function noteIdentity(pitch) {
  const pitchClass = pitch % 12;
  const octave = Math.floor(pitch / 12) - 2;
  return { pitchClass, octave, noteName: `${NOTE_NAMES[pitchClass]}${octave}` };
}

function requireNote(note, index) {
  if (!Number.isInteger(note?.noteId)) throw new Error(`notes[${index}].noteId must be an integer`);
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127)
    throw new Error(`notes[${index}].pitch must be an integer from 0 to 127`);
  if (typeof note.mute !== "boolean") throw new Error(`notes[${index}].mute must be boolean`);
}

function correction(pitch, scalePitchClasses, direction) {
  for (let distance = 1; distance < 12; distance += 1) {
    const candidatePitch = pitch + distance * direction;
    if (candidatePitch < 0 || candidatePitch > 127) return null;
    const pitchClass = candidatePitch % 12;
    const degreeIndex = scalePitchClasses.indexOf(pitchClass);
    if (degreeIndex >= 0) return {
      pitch: candidatePitch, noteName: noteIdentity(candidatePitch).noteName,
      semitones: distance * direction, degree: degreeIndex + 1
    };
  }
  return null;
}

export function analyzeMidiNotesAgainstScale(notes, key) {
  if (!Array.isArray(notes)) throw new Error("notes must be an array");
  const scale = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(scale.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  const analyzed = notes.map((note, index) => {
    requireNote(note, index);
    const identity = noteIdentity(note.pitch);
    const degreeIndex = scale.pitchClasses.indexOf(identity.pitchClass);
    if (degreeIndex >= 0) return {
      noteId: note.noteId, pitch: note.pitch, ...identity,
      inScale: true, degree: degreeIndex + 1, mute: note.mute, corrections: null
    };
    const lower = correction(note.pitch, scale.pitchClasses, -1);
    const upper = correction(note.pitch, scale.pitchClasses, 1);
    const available = [lower, upper].filter(Boolean);
    const nearestDistance = Math.min(...available.map(candidate => Math.abs(candidate.semitones)));
    return {
      noteId: note.noteId, pitch: note.pitch, ...identity,
      inScale: false, degree: null, mute: note.mute,
      corrections: { lower, upper,
        nearest: available.filter(candidate => Math.abs(candidate.semitones) === nearestDistance) }
    };
  });
  const pitches = analyzed.map(note => note.pitch);
  return {
    scale,
    notes: analyzed,
    summary: {
      totalNotes: analyzed.length,
      inScaleNotes: analyzed.filter(note => note.inScale).length,
      offScaleNotes: analyzed.filter(note => !note.inScale).length,
      mutedNotes: analyzed.filter(note => note.mute).length,
      usedDegrees: [...new Set(analyzed.filter(note => note.inScale).map(note => note.degree))].sort((a, b) => a - b),
      chromaticNoteIds: analyzed.filter(note => !note.inScale).map(note => note.noteId),
      pitchRange: pitches.length ? { lowest: Math.min(...pitches), highest: Math.max(...pitches) } : null
    }
  };
}

export function planMidiScaleCorrections(analysis, noteIds, direction, tieBreak) {
  if (!["nearest", "up", "down"].includes(direction))
    throw new Error("direction must be nearest, up, or down");
  if (tieBreak !== undefined && !["up", "down"].includes(tieBreak))
    throw new Error("tieBreak must be up or down");
  if (noteIds !== undefined && (!Array.isArray(noteIds) || noteIds.length === 0))
    throw new Error("noteIds must be a non-empty array when provided");

  const notes = new Map(analysis.notes.map(note => [note.noteId, note]));
  const selectedIds = noteIds ?? analysis.summary.chromaticNoteIds;
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error("noteIds must be unique");
  if (selectedIds.length === 0) throw new Error("no off-scale notes require correction");

  return selectedIds.map(noteId => {
    if (!Number.isInteger(noteId)) throw new Error("noteIds must contain integers");
    const note = notes.get(noteId);
    if (!note) throw new Error(`unknown noteId ${noteId}`);
    if (note.inScale) throw new Error(`noteId ${noteId} is already in scale`);

    let candidate;
    if (direction === "up") candidate = note.corrections.upper;
    else if (direction === "down") candidate = note.corrections.lower;
    else {
      const nearest = note.corrections.nearest;
      if (nearest.length > 1 && tieBreak === undefined)
        throw new Error(`noteId ${noteId} has an equal nearest correction; tieBreak is required`);
      candidate = nearest.length === 1
        ? nearest[0]
        : nearest.find(item => Math.sign(item.semitones) === (tieBreak === "up" ? 1 : -1));
    }
    if (!candidate) throw new Error(`noteId ${noteId} has no ${direction} correction within the MIDI range`);
    return {
      noteId,
      previous: { pitch: note.pitch, noteName: note.noteName },
      pitch: candidate.pitch,
      noteName: candidate.noteName,
      degree: candidate.degree,
      semitones: candidate.semitones
    };
  });
}
