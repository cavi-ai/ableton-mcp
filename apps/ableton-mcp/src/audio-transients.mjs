export function detectSourceTransients(decoded, sampleRate, startSeconds, channelIndex) {
  const sampleCount = Math.floor(decoded.length / 4);
  const hopSize = Math.round(sampleRate / 100);
  const levels = [];
  for (let begin = 0; begin < sampleCount; begin += hopSize) {
    const end = Math.min(begin + hopSize, sampleCount);
    let energy = 0;
    for (let i = begin; i < end; i++) {
      const sample = decoded.readFloatLE(i * 4);
      if (!Number.isFinite(sample)) throw new Error("transient source contains nonfinite samples");
      energy += sample * sample;
    }
    levels.push(Math.sqrt(energy / (end - begin)));
  }
  const rises = levels.map((level, index) => index ? Math.max(0, level - levels[index - 1]) : 0);
  const strongest = Math.max(0, ...rises);
  const candidates = [];
  for (let index = 1; index < rises.length && candidates.length < 256; index++) {
    if (rises[index] < Math.max(0.005, strongest * 0.15)) continue;
    if (candidates.length && index - candidates.at(-1).hopIndex < 5) {
      if (rises[index] > candidates.at(-1).rise) candidates[candidates.length - 1] = { hopIndex: index, rise: rises[index] };
      continue;
    }
    candidates.push({ hopIndex: index, rise: rises[index] });
  }
  return { scope: "source_audio", channelIndex, sampleRate, hopSize,
    candidates: candidates.map(({ hopIndex, rise }) => ({ sourceSeconds: startSeconds + hopIndex * hopSize / sampleRate,
      strength: rise / strongest })),
    limitation: "Selected-channel source-only 10-ms RMS-rise candidates, capped at 256 and separated by at least 50 ms. Quiet or legato attacks may be missed; steady dynamics and noise can yield false candidates. Not native-rate sample-accurate transients, warped clip time, rendered Live audio, or slice/warp markers." };
}
