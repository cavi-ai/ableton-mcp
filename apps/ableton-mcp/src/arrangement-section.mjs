import { assertTonalNote, describeTonalEvidence } from "./session-orientation.mjs";

const scope = "Stored MIDI note overlaps projected into this Arrangement window, including muted material; not triggered notes or audible playback.";
const finite = value => typeof value === "number" && Number.isFinite(value);

function project(part, range, budget) {
  const timing = part.clipTiming, timeline = part.timeline;
  if (!timing || !timeline || ![timeline.startBeats,timeline.endBeats,timing.startMarkerBeats,timing.endMarkerBeats].every(finite) ||
      timeline.endBeats <= timeline.startBeats || timing.endMarkerBeats <= timing.startMarkerBeats || typeof timing.looping !== "boolean")
    throw new Error("Arrangement clip timing is invalid; section projection is unavailable");
  if (!Array.isArray(part.notes) || part.notes.length > 4096) throw new Error("section supports at most 4096 stored notes per clip");
  for (const note of part.notes) assertTonalNote(note);
  const start = Math.max(range.startBeats,timeline.startBeats), end = Math.min(range.endBeats,timeline.endBeats);
  if (end <= start) throw new Error("Arrangement part does not overlap the requested section");
  const weights = Array(12).fill(0);
  let included = 0, lowest = Infinity, highest = -Infinity, segments = 0;
  const segment = (songStart, localStart, localEnd) => {
    const low = Math.max(localStart, localStart + start - songStart);
    const high = Math.min(localEnd, localStart + end - songStart);
    if (high <= low) return;
    segments++;
    for (const note of part.notes) {
      if (note.mute) continue;
      const duration = Math.max(0, Math.min(note.start + note.duration,high) - Math.max(note.start,low));
      if (!duration) continue;
      weights[note.pitch % 12] += duration;included++;
      lowest = Math.min(lowest,note.pitch);highest = Math.max(highest,note.pitch);
    }
  };
  if (timing.looping) {
    const loopStart = timing.loopStartBeats, loopEnd = timing.loopEndBeats, marker = timing.startMarkerBeats;
    if (![loopStart,loopEnd].every(finite) || loopEnd <= loopStart || marker >= loopEnd)
      throw new Error("Arrangement loop timing is invalid; section projection is unavailable");
    const length = loopEnd - loopStart, repeatStart = timeline.startBeats + loopEnd - marker;
    const first = Math.max(0,Math.floor((start - repeatStart) / length));
    const last = Math.max(first,Math.ceil((end - repeatStart) / length));
    const count = last - first + 1;
    budget.visits += count * Math.max(1,part.notes.length);
    if (count > 65536 || budget.visits > 262144) throw new Error("section has too many repeated notes; choose a shorter range or fewer tracks");
    segment(timeline.startBeats,marker,loopEnd);
    for (let cycle = first; cycle < last; cycle++) segment(repeatStart + cycle * length,loopStart,loopEnd);
  } else {
    budget.visits += part.notes.length;
    if (budget.visits > 262144) throw new Error("section has too many notes; choose fewer tracks");
    segment(timeline.startBeats,timing.startMarkerBeats,timing.endMarkerBeats);
  }
  return { weights,included,segments,pitchRange: included ? {lowest,highest} : null,
    sectionRange: {startBeats:start,endBeats:end} };
}

export function assertArrangementRange(range) {
  if (!range || ![range.startBeats,range.endBeats].every(finite) || range.startBeats < 0 || range.endBeats <= range.startBeats || range.endBeats - range.startBeats > 512)
    throw new Error("Arrangement section requires an increasing range of at most 512 beats");
}

export function enrichArrangementSection(snapshot) {
  const {range} = snapshot;
  assertArrangementRange(range);
  const weights = Array(12).fill(0), budget = {visits:0};
  let analyzedParts = 0, included = 0;
  const parts = snapshot.parts.map(({notes,...part}) => {
    if (part.status !== "available") return {...part,tonalEvidence:null,pitchRange:null};
    const result = project({...part,notes},range,budget);
    for (let pitch = 0; pitch < 12; pitch++) weights[pitch] += result.weights[pitch];
    analyzedParts++;included += result.included;
    return {...part,sectionRange:result.sectionRange,projectedSegments:result.segments,projectedNoteOverlaps:result.included,
      pitchRange:result.pitchRange,tonalEvidence:describeTonalEvidence(result.weights,result.included,result.sectionRange,snapshot.musicalContext.key,scope)};
  });
  const excludedParts = parts.length - analyzedParts;
  return {...snapshot,parts,coverage:{requestedParts:parts.length,analyzedParts,excludedParts,
    status:!parts.length ? "empty" : !analyzedParts ? "unavailable" : excludedParts ? "partial" : "complete"},
    combined:analyzedParts ? describeTonalEvidence(weights,included,range,snapshot.musicalContext.key,scope) : null,
    scope,limitations:["Projection clips stored note spans at each initial/loop segment and the requested window; counts are note/segment overlaps, not note-on events.",
      "Muted tracks/clips are included. Group mutes, solo, Session overrides, routing and device processing are not modeled as audibility.",
      "Groove, probability, MIDI chase and rendered audio are not measured. Configured scale is observed now, not a key or meter map for this section."]};
}
