import { frequencyPitchReference } from "./audio-spectrum.mjs";

export function estimateMonophonicPitch(samples, sampleRate) {
  if (samples.length !== 4096) throw new Error("pitch estimation requires 4096 samples");
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("unsupported pitch sample rate");
  let energy = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error("samples must be finite");
    energy += sample * sample;
  }
  if (energy / samples.length < 1e-10) return null;
  const minLag = Math.max(2, Math.ceil(sampleRate / 2000));
  const maxLag = Math.min(2047, Math.floor(sampleRate / 50));
  const difference = new Float64Array(maxLag + 1);
  const normalized = new Float64Array(maxLag + 1);
  normalized[0] = 1;
  let sum = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    for (let i = 0; i < 2048; i++) {
      const delta = samples[i] - samples[i + lag];
      difference[lag] += delta * delta;
    }
    sum += difference[lag];
    normalized[lag] = sum === 0 ? 1 : difference[lag] * lag / sum;
  }
  for (let lag = minLag; lag < maxLag; lag++) {
    if (normalized[lag] >= 0.1) continue;
    while (lag + 1 < maxLag && normalized[lag + 1] < normalized[lag]) lag++;
    const left = normalized[lag - 1], center = normalized[lag], right = normalized[lag + 1];
    const curvature = left - 2 * center + right;
    const offset = curvature === 0 ? 0 : Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature));
    const frequencyHz = sampleRate / (lag + offset);
    return { frequencyHz, periodicityConfidence: 1 - center,
      pitchReference: frequencyPitchReference(frequencyHz), method: "yin_cumulative_mean_difference",
      limitation: "Single-frame monophonic periodicity estimate; unreliable for polyphonic or unvoiced audio. Not pitch correction." };
  }
  return null;
}
