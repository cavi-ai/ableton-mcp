import { getLiveScaleReference } from "./live-scale-reference.mjs";

const NOTE_NAMES = ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
const TEMPLATES = [
  { quality: "major", intervals: [0, 4, 7], suffix: "" },
  { quality: "minor", intervals: [0, 3, 7], suffix: "m" },
  { quality: "diminished", intervals: [0, 3, 6], suffix: "dim" },
  { quality: "augmented", intervals: [0, 4, 8], suffix: "+" },
  { quality: "suspended 2", intervals: [0, 2, 7], suffix: "sus2" },
  { quality: "suspended 4", intervals: [0, 5, 7], suffix: "sus4" },
  { quality: "dominant 7", intervals: [0, 4, 7, 10], suffix: "7" },
  { quality: "major 7", intervals: [0, 4, 7, 11], suffix: "maj7" },
  { quality: "minor 7", intervals: [0, 3, 7, 10], suffix: "m7" },
  { quality: "half-diminished 7", intervals: [0, 3, 6, 10], suffix: "m7b5" },
  { quality: "diminished 7", intervals: [0, 3, 6, 9], suffix: "dim7" }
];

function requireNote(note, index) {
  if (!Number.isInteger(note?.noteId)) throw new Error(`notes[${index}].noteId must be an integer`);
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127)
    throw new Error(`notes[${index}].pitch must be an integer from 0 to 127`);
  if (!Number.isFinite(note.start) || note.start < 0) throw new Error(`notes[${index}].start must be nonnegative`);
  if (!Number.isFinite(note.duration) || note.duration <= 0) throw new Error(`notes[${index}].duration must be positive`);
  if (typeof note.mute !== "boolean") throw new Error(`notes[${index}].mute must be boolean`);
}

function romanNumeral(rootDegree, quality) {
  if (rootDegree === null) return null;
  const minor = quality === "minor" || quality === "minor 7" || quality.startsWith("diminished") || quality === "half-diminished 7";
  const base = minor ? ROMAN[rootDegree - 1].toLowerCase() : ROMAN[rootDegree - 1];
  if (quality === "diminished") return `${base}°`;
  if (quality === "augmented") return `${base}+`;
  if (quality === "dominant 7" || quality === "minor 7") return `${base}7`;
  if (quality === "major 7") return `${base}maj7`;
  if (quality === "half-diminished 7") return `${base}ø7`;
  if (quality === "diminished 7") return `${base}°7`;
  if (quality === "suspended 2") return `${base}sus2`;
  if (quality === "suspended 4") return `${base}sus4`;
  return base;
}

function identifyCandidates(pitchClasses, bassPitchClass, scale) {
  const candidates = [];
  for (let rootPitchClass = 0; rootPitchClass < 12; rootPitchClass += 1) {
    const intervals = pitchClasses.map(pitchClass => (pitchClass - rootPitchClass + 12) % 12).sort((a, b) => a - b);
    const template = TEMPLATES.find(item => JSON.stringify(item.intervals) === JSON.stringify(intervals));
    if (!template) continue;
    const rootDegreeIndex = scale.pitchClasses.indexOf(rootPitchClass);
    const rootDegree = rootDegreeIndex < 0 ? null : rootDegreeIndex + 1;
    const inversion = template.intervals.indexOf((bassPitchClass - rootPitchClass + 12) % 12);
    candidates.push({
      name: `${NOTE_NAMES[rootPitchClass]} ${template.quality}`,
      symbol: `${NOTE_NAMES[rootPitchClass]}${template.suffix}`,
      rootPitchClass,
      rootName: NOTE_NAMES[rootPitchClass],
      quality: template.quality,
      intervals: [...template.intervals],
      inversion,
      bassPitchClass,
      bassName: NOTE_NAMES[bassPitchClass],
      romanNumeral: romanNumeral(rootDegree, template.quality),
      rootDegree,
      inScale: pitchClasses.every(pitchClass => scale.pitchClasses.includes(pitchClass))
    });
  }
  return candidates.sort((a, b) =>
    Number(b.rootPitchClass === bassPitchClass) - Number(a.rootPitchClass === bassPitchClass) ||
    Number(b.rootDegree !== null) - Number(a.rootDegree !== null) ||
    a.rootPitchClass - b.rootPitchClass
  );
}

export function analyzeMidiChordEvents(notes, key) {
  if (!Array.isArray(notes)) throw new Error("notes must be an array");
  notes.forEach(requireNote);
  const scale = getLiveScaleReference(key?.scaleName, key?.rootNote);
  if (JSON.stringify(scale.intervals) !== JSON.stringify(key?.scaleIntervals))
    throw new Error("scale intervals do not match the Live scale reference");
  const audible = notes.filter(note => !note.mute);
  const starts = [...new Set(audible.map(note => note.start))].sort((a, b) => a - b);
  const events = [];
  let previousSignature = null;
  for (const startBeats of starts) {
    const active = audible.filter(note => note.start <= startBeats && note.start + note.duration > startBeats)
      .sort((a, b) => a.pitch - b.pitch || a.noteId - b.noteId);
    const pitchClasses = [...new Set(active.map(note => note.pitch % 12))].sort((a, b) => a - b);
    if (pitchClasses.length < 3) continue;
    const bassPitchClass = active[0].pitch % 12;
    const signature = `${bassPitchClass}:${pitchClasses.join(",")}`;
    if (signature === previousSignature) continue;
    previousSignature = signature;
    const candidates = identifyCandidates(pitchClasses, bassPitchClass, scale);
    events.push({
      startBeats,
      noteIds: active.map(note => note.noteId),
      pitches: active.map(note => note.pitch),
      pitchClasses,
      chromaticPitchClasses: pitchClasses.filter(pitchClass => !scale.pitchClasses.includes(pitchClass)),
      candidates,
      ambiguous: candidates.length > 1,
      unknown: candidates.length === 0
    });
  }
  return {
    scale,
    events,
    summary: {
      eventCount: events.length,
      recognizedEvents: events.filter(event => !event.unknown).length,
      ambiguousEvents: events.filter(event => event.ambiguous).length,
      chromaticEvents: events.filter(event => event.chromaticPitchClasses.length > 0).length
    }
  };
}
