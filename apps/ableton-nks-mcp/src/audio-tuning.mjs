const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function measureTargetNoteDeviation(frames, targetMidiNote) {
  if (!Number.isInteger(targetMidiNote) || targetMidiNote < 0 || targetMidiNote > 127) throw new Error("target MIDI note must be an integer from 0 to 127");
  if (!Array.isArray(frames) || !frames.length || frames.length > 512) throw new Error("bounded pitch frames required");
  const targetFrequencyHz = 440 * 2 ** ((targetMidiNote - 69) / 12);
  const measured = frames.map(frame => {
    if (!Number.isFinite(frame.startSeconds) || !Number.isFinite(frame.endSeconds) || frame.endSeconds <= frame.startSeconds) throw new Error("invalid pitch frame times");
    const frequencyHz = frame.estimate?.frequencyHz;
    if (frame.estimate != null && (!Number.isFinite(frequencyHz) || frequencyHz <= 0)) throw new Error("invalid estimated frequency");
    return { startSeconds: frame.startSeconds, endSeconds: frame.endSeconds,
      frequencyHz: frequencyHz ?? null, centsFromTarget: frequencyHz == null ? null : 1200 * Math.log2(frequencyHz / targetFrequencyHz) };
  });
  const cents = measured.flatMap(frame => frame.centsFromTarget === null ? [] : [frame.centsFromTarget]);
  return { targetMidiNote, targetFrequencyHz, referenceA4Hz: 440, pitchCorrectionApplied: false, frames: measured,
    measuredFrames: cents.length, totalFrames: measured.length, measuredFrameFraction: cents.length / measured.length,
    medianCentsFromTarget: median(cents), medianAbsoluteCentsFromTarget: median(cents.map(Math.abs)),
    limitation: "Deviation against one explicitly selected equal-tempered note at A4=440 Hz. Not melody/scale inference, pitch correction, or vocal quality grading. Octave deviations are not folded. Unreliable periodicity remains null. Overlapping-frame statistics are not duration-weighted or temporal coverage estimates; transitions and vibrato can affect measurements." };
}
