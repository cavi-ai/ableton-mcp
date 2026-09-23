const NOTE_NAMES = ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"];

const definitions = [
  ["Major", "major-mode", [0, 2, 4, 5, 7, 9, 11]],
  ["Minor", "major-mode", [0, 2, 3, 5, 7, 8, 10]],
  ["Dorian", "major-mode", [0, 2, 3, 5, 7, 9, 10]],
  ["Mixolydian", "major-mode", [0, 2, 4, 5, 7, 9, 10]],
  ["Lydian", "major-mode", [0, 2, 4, 6, 7, 9, 11]],
  ["Phrygian", "major-mode", [0, 1, 3, 5, 7, 8, 10]],
  ["Locrian", "major-mode", [0, 1, 3, 5, 6, 8, 10]],
  ["Whole Tone", "symmetric", [0, 2, 4, 6, 8, 10]],
  ["Half-whole Dim.", "symmetric", [0, 1, 3, 4, 6, 7, 9, 10]],
  ["Whole-half Dim.", "symmetric", [0, 2, 3, 5, 6, 8, 9, 11]],
  ["Minor Blues", "blues", [0, 3, 5, 6, 7, 10]],
  ["Minor Pentatonic", "pentatonic", [0, 3, 5, 7, 10]],
  ["Major Pentatonic", "pentatonic", [0, 2, 4, 7, 9]],
  ["Harmonic Minor", "harmonic", [0, 2, 3, 5, 7, 8, 11]],
  ["Harmonic Major", "harmonic", [0, 2, 4, 5, 7, 8, 11]],
  ["Dorian #4", "harmonic", [0, 2, 3, 6, 7, 9, 10]],
  ["Phrygian Dominant", "harmonic", [0, 1, 4, 5, 7, 8, 10]],
  ["Melodic Minor", "melodic-minor-mode", [0, 2, 3, 5, 7, 9, 11]],
  ["Lydian Augmented", "melodic-minor-mode", [0, 2, 4, 6, 8, 9, 11]],
  ["Lydian Dominant", "melodic-minor-mode", [0, 2, 4, 6, 7, 9, 10]],
  ["Super Locrian", "melodic-minor-mode", [0, 1, 3, 4, 6, 8, 10]],
  ["8-Tone Spanish", "world", [0, 1, 3, 4, 5, 6, 8, 10]],
  ["Bhairav", "world", [0, 1, 4, 5, 7, 8, 11]],
  ["Hungarian Minor", "world", [0, 2, 3, 6, 7, 8, 11]],
  ["Hirajoshi", "world", [0, 2, 3, 7, 8]],
  ["In-Sen", "world", [0, 1, 5, 7, 10]],
  ["Iwato", "world", [0, 1, 5, 6, 10]],
  ["Kumoi", "world", [0, 2, 3, 7, 9]],
  ["Pelog Selisir", "world", [0, 1, 3, 7, 8]],
  ["Pelog Tembung", "world", [0, 1, 5, 7, 8]],
  ["Messiaen 3", "messiaen", [0, 2, 3, 4, 6, 7, 8, 10, 11]],
  ["Messiaen 4", "messiaen", [0, 1, 2, 5, 6, 7, 8, 11]],
  ["Messiaen 5", "messiaen", [0, 1, 5, 6, 7, 11]],
  ["Messiaen 6", "messiaen", [0, 2, 4, 5, 6, 8, 10, 11]],
  ["Messiaen 7", "messiaen", [0, 1, 2, 3, 5, 6, 7, 8, 9, 11]]
].map(([name, family, intervals]) => ({ name, family, intervals }));

const byName = new Map(definitions.map(scale => [scale.name, scale]));

function requireRoot(rootNote) {
  if (!Number.isInteger(rootNote) || rootNote < 0 || rootNote > 11)
    throw new Error("rootNote must be an integer from 0 to 11");
}

export function listLiveScaleReferences() {
  return definitions.map(scale => ({ ...scale, intervals: [...scale.intervals] }));
}

export function getLiveScaleReference(scaleName, rootNote) {
  requireRoot(rootNote);
  const scale = byName.get(scaleName);
  if (!scale) throw new Error(`unknown Live scale: ${scaleName}`);
  const pitchClasses = scale.intervals.map(interval => (rootNote + interval) % 12);
  return {
    ...scale, intervals: [...scale.intervals], rootNote, rootName: NOTE_NAMES[rootNote],
    pitchClasses, noteNames: pitchClasses.map(note => NOTE_NAMES[note]),
    degrees: scale.intervals.map((_, index) => index + 1)
  };
}

export function enrichSongScaleContext(context) {
  const reference = getLiveScaleReference(context.key.scaleName, context.key.rootNote);
  if (JSON.stringify(reference.intervals) !== JSON.stringify(context.key.scaleIntervals))
    throw new Error("Live scale intervals do not match the scale reference");
  return {
    ...context,
    key: { ...context.key, family: reference.family, pitchClasses: reference.pitchClasses,
      noteNames: reference.noteNames, degrees: reference.degrees },
    pianoRoll: {
      scaleMode: { value: context.key.scaleMode, effect: "highlight-scale-notes",
        scope: "Live-set-key-and-scale", drivesScaleAwareDevices: true },
      foldToScale: {
        scope: "selected-midi-clip-editor", directControlAvailable: false,
        effect: "hide-non-scale-note-lanes", preservesOffScaleNotes: true,
        limitation: "Live's control-surface API does not expose the piano-roll Fold to Scale UI state."
      }
    }
  };
}
