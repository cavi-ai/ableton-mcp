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
  const center = median(cents);
  const measuredFrameFraction = cents.length / measured.length;
  const maximumSpreadCents = center === null ? null : Math.max(...cents.map(value => Math.abs(value - center)));
  const shiftCents = center === null ? null : Math.round(-center) || 0;
  const coarse = shiftCents === null ? null : Math.round(shiftCents / 100);
  const fine = shiftCents === null ? null : shiftCents - coarse * 100;
  const eligible = cents.length >= 4 && measuredFrameFraction >= .8 && maximumSpreadCents <= 25 &&
    coarse >= -48 && coarse <= 48 && fine >= -50 && fine <= 50;
  const reason = eligible ? "stable_monophonic_source_window" : cents.length < 4 ? "insufficient_voiced_frames" :
    measuredFrameFraction < .8 ? "insufficient_voiced_fraction" : maximumSpreadCents > 25 ?
      "variable_pitch_or_unreliable_estimates" : "offset_outside_clip_range";
  return { targetMidiNote, targetFrequencyHz, referenceA4Hz: 440, pitchCorrectionApplied: false, frames: measured,
    measuredFrames: cents.length, totalFrames: measured.length, measuredFrameFraction,
    medianCentsFromTarget: center, medianAbsoluteCentsFromTarget: median(cents.map(Math.abs)),
    wholeClipTuningProposal: { eligible, reason, maximumSpreadCents,
      pitchOffset: eligible ? { coarse, fine } : null,
      limitation: "Review-only offset relative to untransposed source audio for one target note and selected analysis window. Do not apply blindly to an already-transposed clip. Whole-clip pitch offsets cannot correct changing notes, vocal intonation, or different source windows; inspect the full material and current clip pitch before a guarded edit." },
    limitation: "Deviation against one explicitly selected equal-tempered note at A4=440 Hz. Not melody/scale inference, pitch correction, or vocal quality grading. Octave deviations are not folded. Unreliable periodicity remains null. Overlapping-frame statistics are not duration-weighted or temporal coverage estimates; transitions and vibrato can affect measurements." };
}

export function planClipPitchAdjustment(measurement, currentPitch) {
  const offset = measurement?.wholeClipTuningProposal;
  const validCurrent = currentPitch && Number.isInteger(currentPitch.coarse) &&
    currentPitch.coarse >= -48 && currentPitch.coarse <= 48 &&
    Number.isInteger(currentPitch.fine) && currentPitch.fine >= -50 && currentPitch.fine <= 50;
  const eligible = offset?.eligible === true && validCurrent === true;
  const proposedPitch = eligible ? offset.pitchOffset : null;
  return { eligible, reason: !validCurrent ? "clip_pitch_unavailable" : offset?.reason ?? "tuning_measurement_unavailable",
    currentPitch: validCurrent ? { coarse: currentPitch.coarse, fine: currentPitch.fine } : null,
    proposedPitch, changeCents: eligible ?
      (proposedPitch.coarse - currentPitch.coarse) * 100 + proposedPitch.fine - currentPitch.fine : null,
    applied: false,
    limitation: "Review-only absolute clip-pitch settings based on the selected monophonic source window and target note. Not a correction of changing notes or rendered audio. Check the rest of the source, warp mode, and audible result before separately applying with set_audio_clip_state against current Live state." };
}
