const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function segmentPitchEvents(frames) {
  if (!Array.isArray(frames) || !frames.length || frames.length > 512)
    throw new Error("pitch events require one to 512 ordered analysis frames");
  const centers = frames.map((frame, index) => {
    if (!Number.isFinite(frame.startSeconds) || !Number.isFinite(frame.endSeconds) ||
        frame.endSeconds <= frame.startSeconds ||
        (index > 0 && (frame.startSeconds <= frames[index - 1].startSeconds ||
          frame.startSeconds + frame.endSeconds <= frames[index - 1].startSeconds + frames[index - 1].endSeconds)))
      throw new Error("pitch event frames must have increasing finite times");
    const pitch = frame.estimate?.pitchReference;
    if (pitch && (!Number.isInteger(pitch.midiNote) || pitch.midiNote < 0 || pitch.midiNote > 127 ||
        typeof pitch.noteName !== "string" || !Number.isFinite(pitch.centsFromNote)))
      throw new Error("invalid pitch reference in analysis frame");
    return (frame.startSeconds + frame.endSeconds) / 2;
  });
  const events = [];
  let unvoicedFrameCount = 0, discardedShortRuns = 0;
  for (let start = 0; start < frames.length;) {
    const pitch = frames[start].estimate?.pitchReference;
    if (!pitch) { unvoicedFrameCount++; start++; continue; }
    let end = start + 1;
    while (end < frames.length && frames[end].estimate?.pitchReference?.midiNote === pitch.midiNote) end++;
    if (end - start < 2) { discardedShortRuns++; start = end; continue; }
    const run = frames.slice(start, end);
    events.push({ midiNote: pitch.midiNote, noteName: pitch.noteName,
      startSeconds: start === 0 ? frames[0].startSeconds : (centers[start - 1] + centers[start]) / 2,
      endSeconds: end === frames.length ? frames.at(-1).endSeconds : (centers[end - 1] + centers[end]) / 2,
      voicedFrames: run.length,
      medianCentsFromNote: median(run.map(frame => frame.estimate.pitchReference.centsFromNote)),
      centsRange: { min: Math.min(...run.map(frame => frame.estimate.pitchReference.centsFromNote)),
        max: Math.max(...run.map(frame => frame.estimate.pitchReference.centsFromNote)) } });
    start = end;
  }
  return { events, frameCount: frames.length, unvoicedFrameCount, discardedShortRuns,
    minimumVoicedFrames: 2, boundaryUncertaintySeconds: Math.max(...frames.map(frame => (frame.endSeconds - frame.startSeconds) / 2)),
    limitation: "Heuristic source-audio note candidates from overlapping monophonic pitch frames. Boundaries are approximate; vibrato, transitions, polyphony, octave errors and unvoiced consonants can split or hide notes. No audio correction is applied." };
}
