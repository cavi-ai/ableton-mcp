import { getLiveScaleReference, listLiveScaleReferences } from "./live-scale-reference.mjs";

const names = Array.from({ length: 12 }, (_, root) => getLiveScaleReference("Major", root).rootName);
const groups = new Map();
for (const scale of listLiveScaleReferences().filter(scale => scale.family === "major-mode")) {
  for (let rootNote = 0; rootNote < 12; rootNote++) {
    const reference = getLiveScaleReference(scale.name, rootNote);
    const pitchClasses = [...reference.pitchClasses].sort((a, b) => a - b);
    const id = pitchClasses.join(",");
    if (!groups.has(id)) groups.set(id, { pitchClasses, compatibleKeys: [] });
    groups.get(id).compatibleKeys.push({ rootNote, rootName: reference.rootName, scaleName: scale.name });
  }
}

export function assertTonalNote(note) {
  if (!note || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || typeof note.mute !== "boolean" ||
      !Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.duration <= 0)
    throw new Error("tonal evidence received an invalid MIDI note");
}

export function analyzeTonalEvidence(notes, range, configuredKey) {
  if (!Array.isArray(notes) || notes.length > 4096) throw new Error("tonal evidence requires at most 4096 notes");
  if (!Number.isFinite(range?.startBeats) || !Number.isFinite(range?.endBeats) || range.endBeats <= range.startBeats)
    throw new Error("tonal evidence requires a finite increasing clip range");
  const weights = Array(12).fill(0);
  let includedNotes = 0;
  for (const note of notes) {
    assertTonalNote(note);
    if (note.mute) continue;
    const duration = Math.max(0, Math.min(note.start + note.duration, range.endBeats) - Math.max(note.start, range.startBeats));
    if (!duration) continue;
    weights[note.pitch % 12] += duration;
    includedNotes++;
  }
  return describeTonalEvidence(weights, includedNotes, range, configuredKey,
    "Selected clip range only; not the whole Set or rendered sound.");
}

export function describeTonalEvidence(weights, includedNotes, range, configuredKey, scope) {
  const totalDuration = weights.reduce((sum, value) => sum + value, 0);
  const pitchClasses = weights.flatMap((durationBeats, pitchClass) => durationBeats ? [{ pitchClass,
    name: names[pitchClass], durationBeats }] : []);
  const support = classes => totalDuration ? classes.reduce((sum, pitch) => sum + weights[pitch], 0) / totalDuration : null;
  const ranked = [...groups.values()].map(group => ({ ...group, supportFraction: support(group.pitchClasses) }))
    .sort((a, b) => b.supportFraction - a.supportFraction || a.pitchClasses.join(",").localeCompare(b.pitchClasses.join(",")));
  const insufficient = pitchClasses.length < 3;
  const best = ranked[0].supportFraction;
  const tiedBestGroupCount = insufficient ? 0 : ranked.filter(group => Math.abs(group.supportFraction - best) < 1e-12).length;
  let configuredScale = null;
  if (configuredKey) {
    const reference = getLiveScaleReference(configuredKey.scaleName, configuredKey.rootNote);
    if (JSON.stringify(reference.intervals) !== JSON.stringify(configuredKey.scaleIntervals))
      throw new Error("configured Live scale intervals do not match the scale reference");
    configuredScale = { rootNote: reference.rootNote, rootName: reference.rootName, scaleName: reference.name,
      supportFraction: support(reference.pitchClasses),
      offScalePitchClasses: pitchClasses.filter(p => !reference.pitchClasses.includes(p.pitchClass)).map(p => p.pitchClass) };
  }
  return { status: insufficient ? "insufficient" : "ambiguous", confirmedKey: null,
    method: "duration-weighted-diatonic-compatibility", range, includedNotes, pitchClasses, configuredScale,
    candidateGroups: insufficient ? [] : ranked.slice(0, 3), tiedBestGroupCount,
    candidatesTruncated: !insufficient && ranked.length > 3,
    limitations: [scope,
      "Support is the fraction of summed unmuted note durations in a pitch-class set, not a key probability.",
      "Relative keys and modes share pitch classes; this method does not establish a tonic, cadence or confirmed key.",
      "Only diatonic modes are ranked; chromatic, non-diatonic and mixed material may not fit.",
      "Stored notes can trigger unpitched samples or be transformed by devices; probability, groove and audio are not measured."] };
}

export function enrichSessionOrientation(snapshot) {
  const { notes, ...focus } = snapshot.focus;
  return { ...snapshot, focus: { ...focus, tonalEvidence: focus.status === "available"
    ? analyzeTonalEvidence(notes, focus.range, snapshot.musicalContext.key) : null } };
}

export function enrichMidiPartsContext(snapshot) {
  const weights = Array(12).fill(0);
  let analyzedParts = 0, includedNotes = 0;
  const parts = snapshot.parts.map(({ notes, ...part }) => {
    if (part.status !== "available") return { ...part, tonalEvidence: null, pitchRange: null };
    const tonalEvidence = analyzeTonalEvidence(notes, part.range, snapshot.musicalContext.key);
    const pitches = notes.filter(note => !note.mute && note.start < part.range.endBeats &&
      note.start + note.duration > part.range.startBeats).map(note => note.pitch);
    for (const pitch of tonalEvidence.pitchClasses) weights[pitch.pitchClass] += pitch.durationBeats;
    analyzedParts++;
    includedNotes += tonalEvidence.includedNotes;
    return { ...part, tonalEvidence, pitchRange: pitches.length
      ? { lowest: Math.min(...pitches), highest: Math.max(...pitches) } : null };
  });
  const excludedParts = parts.length - analyzedParts;
  return { ...snapshot, parts, coverage: { requestedParts: parts.length, analyzedParts, excludedParts,
    status: !analyzedParts ? "unavailable" : excludedParts ? "partial" : "complete" },
    combined: analyzedParts ? describeTonalEvidence(weights, includedNotes, null, snapshot.musicalContext.key,
      "Sum of the explicitly selected clip ranges, including muted tracks/clips; not simultaneous playback, loop-repeat weighting or whole-Set evidence.") : null };
}
