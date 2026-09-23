const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function inspectSpectralPersistence({ sampleRate, frameSize, frames }) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(frameSize) || frameSize < 32 || frameSize > 32768 || (frameSize & (frameSize - 1))) throw new Error("invalid spectral dimensions");
  if (!Array.isArray(frames) || frames.length < 4 || frames.length > 64) throw new Error("at least four and at most 64 spectral frames required");
  const bins = frameSize / 2 + 1;
  for (const [index, frame] of frames.entries()) {
    if (!Number.isFinite(frame.startSeconds) || (index && frame.startSeconds <= frames[index - 1].startSeconds) || !Array.isArray(frame.amplitudesDbfs) || frame.amplitudesDbfs.length !== bins || !frame.amplitudesDbfs.every(Number.isFinite)) throw new Error("spectral frames must have ordered times and complete finite bins");
  }
  const prominenceThresholdDb = 12, minimumAmplitudeDbfs = -60, minimumObservedFrameFraction = .75;
  const candidates = [];
  for (let bin = 8; bin < bins - 8; bin++) {
    const observations = [];
    for (const frame of frames) {
      const values = frame.amplitudesDbfs, amplitudeDbfs = values[bin];
      if (amplitudeDbfs < minimumAmplitudeDbfs || amplitudeDbfs <= values[bin - 1] || amplitudeDbfs < values[bin + 1]) continue;
      const neighborhood = [];
      for (let offset = -8; offset <= 8; offset++) if (Math.abs(offset) >= 3) neighborhood.push(values[bin + offset]);
      const prominenceDb = amplitudeDbfs - median(neighborhood);
      if (prominenceDb >= prominenceThresholdDb) observations.push({ amplitudeDbfs, prominenceDb });
    }
    const observedFrameFraction = observations.length / frames.length;
    if (observedFrameFraction >= minimumObservedFrameFraction) candidates.push({ frequencyHz: bin * sampleRate / frameSize,
      observedFrameFraction, observedFrames: observations.length, totalFrames: frames.length,
      medianAmplitudeDbfs: median(observations.map(x => x.amplitudeDbfs)), medianProminenceDb: median(observations.map(x => x.prominenceDb)) });
  }
  candidates.sort((a, b) => b.medianProminenceDb - a.medianProminenceDb);
  return { confirmedResonance: false, candidates: candidates.slice(0, 32), frequencyResolutionHz: sampleRate / frameSize,
    criteria: { prominenceThresholdDb, minimumAmplitudeDbfs, minimumObservedFrameFraction, neighborhoodRadiusBins: 8, excludedCenterRadiusBins: 2 },
    limitation: "Heuristic persistent narrow spectral features in sampled source frames, not confirmed resonances or corrective-EQ recommendations. Harmonics and sustained tones can qualify. Fixed-bin matching can miss drifting features; sparse frames can miss transients. First/last eight bins are excluded. Verify by listening and contextual analysis before processing." };
}
