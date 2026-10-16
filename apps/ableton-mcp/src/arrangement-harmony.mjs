import { identifyChordCandidates } from "./midi-chord-analysis.mjs";

// Counts retain overlapping repetitions and doubled pitches until their last
// projected span ends. Boundaries are half open, including at note releases.
function changeCount(counts, key, delta) {
  const next = (counts.get(key) ?? 0) + delta;
  if (next) counts.set(key, next);
  else counts.delete(key);
}

export function arrangementHarmony(spans, range, parts) {
  const boundaries = new Map([[range.startBeats, []], [range.endBeats, []]]);
  for (const span of spans) {
    for (const [time, delta] of [[span.startBeats, 1], [span.endBeats, -1]]) {
      if (!boundaries.has(time)) boundaries.set(time, []);
      boundaries.get(time).push({ pitch: span.pitch, part: span.part, delta });
    }
  }
  const times = [...boundaries.keys()].sort((a,b) => a-b);
  const pitches = new Map(), contributors = new Map(), intervals = [];
  let previousSignature, references = 0;
  for (let index = 0; index < times.length - 1; index++) {
    const startBeats = times[index], endBeats = times[index + 1];
    for (const event of boundaries.get(startBeats)) {
      changeCount(pitches, event.pitch, event.delta);
      changeCount(contributors, event.part, event.delta);
    }
    const activePitches = [...pitches.keys()].sort((a,b) => a-b);
    const activeParts = [...contributors.keys()].sort((a,b) => a-b);
    const signature = JSON.stringify([activePitches, activeParts]);
    if (signature === previousSignature) {
      intervals.at(-1).endBeats = endBeats;
      continue;
    }
    if (intervals.length === 256) throw new Error("harmony exceeds 256 intervals; choose a shorter window or omit includeHarmony");
    references += activeParts.length;
    if (references > 4096) throw new Error("harmony exceeds 4096 contributing part references; choose fewer tracks or omit includeHarmony");
    previousSignature = signature;
    const pitchClasses = [...new Set(activePitches.map(pitch => pitch % 12))].sort((a,b) => a-b);
    const bassPitch = activePitches[0] ?? null;
    const candidates = pitchClasses.length < 3 ? [] : identifyChordCandidates(pitchClasses, bassPitch % 12);
    intervals.push({ startBeats, endBeats, pitches: activePitches, pitchClasses, bassPitch,
      parts: activeParts.map(part => ({ trackId: parts[part].trackId, clipId: parts[part].clipId })), candidates,
      status: !activePitches.length ? "empty" : pitchClasses.length < 3 ? "sparse"
        : !candidates.length ? "unrecognized" : candidates.length > 1 ? "ambiguous" : "candidate" });
  }
  return { intervals, intervalCount: intervals.length,
    basis: "Projected stored MIDI pitch sets, including material on muted tracks/clips; muted MIDI notes excluded. Not measured audio or confirmed harmony.",
    interpretation: "Exact triad/seventh templates only. Roman numerals, root degrees and scale membership are not inferred. Adjacent identical pitches and contributing parts are merged, including repeated attacks." };
}
