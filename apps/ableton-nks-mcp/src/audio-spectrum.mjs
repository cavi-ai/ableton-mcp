export function analyzeSpectrum(samples, sampleRate) {
  const n = samples.length;
  if (!Number.isInteger(n) || n < 16 || n > 32768 || (n & (n - 1))) throw new Error("frame size must be a power of two between 16 and 32768");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("sample rate must be finite and positive");
  const real = new Float64Array(n), imag = new Float64Array(n);
  let windowSum = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(samples[i])) throw new Error("samples must be finite");
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    real[i] = samples[i] * window;
    windowSum += window;
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let size = 2; size <= n; size *= 2) {
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const angle = -2 * Math.PI * k / size;
        const a = start + k, b = a + size / 2;
        const tr = real[b] * Math.cos(angle) - imag[b] * Math.sin(angle);
        const ti = real[b] * Math.sin(angle) + imag[b] * Math.cos(angle);
        real[b] = real[a] - tr; imag[b] = imag[a] - ti;
        real[a] += tr; imag[a] += ti;
      }
    }
  }
  const amplitudes = Float64Array.from({ length: n / 2 + 1 }, (_, i) => Math.hypot(real[i], imag[i]) * (i === 0 || i === n / 2 ? 1 : 2) / windowSum);
  const peaks = [];
  for (let i = 1; i < n / 2; i++) {
    if (amplitudes[i] > 1e-6 && amplitudes[i] > amplitudes[i - 1] && amplitudes[i] >= amplitudes[i + 1]) {
      const left = Math.log(Math.max(amplitudes[i - 1], Number.MIN_VALUE));
      const center = Math.log(amplitudes[i]);
      const right = Math.log(Math.max(amplitudes[i + 1], Number.MIN_VALUE));
      const curvature = left - 2 * center + right;
      const offset = curvature === 0 ? 0 : Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature));
      peaks.push({ frequencyHz: i * sampleRate / n,
        estimatedFrequencyHz: (i + offset) * sampleRate / n,
        amplitudeDbfs: 20 * Math.log10(amplitudes[i]) });
    }
  }
  peaks.sort((a, b) => b.amplitudeDbfs - a.amplitudeDbfs);
  return { frameSize: n, sampleRate, frequencyResolutionHz: sampleRate / n, window: "periodic_hann", frequencyEstimator: "log_magnitude_parabolic_interpolation", peaks: peaks.slice(0, 10) };
}
