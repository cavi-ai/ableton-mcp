import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { analyzeSpectrum } from "./audio-spectrum.mjs";
import { estimateMonophonicPitch } from "./audio-pitch.mjs";

const run = promisify(execFile);
const limits = { timeout: 30000, maxBuffer: 2 * 1024 * 1024 };

export async function analyzeAudioFile(sourcePath, { startSeconds = 0, durationSeconds = 10, includeSpectrum = false, includePitch = false, includeSpectrogram = false, includeWaveform = false } = {}) {
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) throw new Error("source must be an absolute local file path");
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error("startSeconds must be finite and nonnegative");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60) throw new Error("durationSeconds must be greater than zero and at most 60");
  if (typeof includeSpectrum !== "boolean") throw new Error("includeSpectrum must be boolean");
  if (typeof includePitch !== "boolean") throw new Error("includePitch must be boolean");
  if (typeof includeSpectrogram !== "boolean") throw new Error("includeSpectrogram must be boolean");
  if (typeof includeWaveform !== "boolean") throw new Error("includeWaveform must be boolean");
  const path = await realpath(sourcePath);
  const before = await stat(path, { bigint: true });
  if (!before.isFile()) throw new Error("audio source must be a regular file");
  const probe = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "a:0", "-show_streams", "-show_format", "-of", "json", path], limits);
  const metadata = JSON.parse(probe.stdout);
  const stream = metadata.streams?.[0];
  const length = Number(metadata.format?.duration);
  if (!stream || !Number.isFinite(length) || length <= startSeconds) throw new Error("source has no measurable audio at startSeconds");
  const windowSeconds = Math.min(durationSeconds, length - startSeconds);
  const levels = await run("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-protocol_whitelist", "file,pipe", "-ss", String(startSeconds), "-i", path, "-t", String(windowSeconds), "-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-"], limits);
  const block = [...levels.stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/gs)].at(-1);
  if (!block) throw new Error("audio loudness measurement unavailable");
  const measured = JSON.parse(block[0]);
  let spectrum;
  if (includeSpectrum) {
    const sampleRate = Number(stream.sample_rate);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("source sample rate unavailable");
    const decoded = await run("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-ss", String(startSeconds), "-i", path, "-t", String(Math.min(windowSeconds, 4096 / sampleRate)), "-map", "0:a:0", "-af", "pan=mono|c0=c0", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], { ...limits, encoding: "buffer" });
    const count = Math.min(4096, Math.floor(decoded.stdout.length / 4));
    if (count < 4096) throw new Error("spectral analysis requires a full 4096-sample frame at the window start");
    const samples = Float64Array.from({ length: 4096 }, (_, i) => decoded.stdout.readFloatLE(i * 4));
    spectrum = { ...analyzeSpectrum(samples, sampleRate), channelIndex: 0, startSeconds,
      limitation: "Single-frame spectral peaks, not fundamental or resonance classification." };
  }
  let monophonicPitch;
  if (includePitch) {
    if (windowSeconds < 4096 / 16000) throw new Error("pitch analysis requires a 0.256-second source window");
    const decoded = await run("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-ss", String(startSeconds), "-i", path, "-t", String(windowSeconds), "-map", "0:a:0", "-af", "pan=mono|c0=c0", "-ar", "16000", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], { ...limits, maxBuffer: 4 * 1024 * 1024, encoding: "buffer" });
    if (decoded.stdout.length < 4096 * 4) throw new Error("pitch analysis requires a full 4096-sample frame");
    const samples = Float64Array.from({ length: 4096 }, (_, i) => decoded.stdout.readFloatLE(i * 4));
    const estimate = estimateMonophonicPitch(samples, 16000);
    const sampleCount = Math.floor(decoded.stdout.length / 4);
    const frameCount = Math.min(64, Math.floor(sampleCount / 4096));
    const frames = Array.from({ length: frameCount }, (_, index) => {
      const offset = frameCount === 1 ? 0 : Math.floor(index * (sampleCount - 4096) / (frameCount - 1));
      const frame = Float64Array.from({ length: 4096 }, (_, i) => decoded.stdout.readFloatLE((offset + i) * 4));
      return { startSeconds: startSeconds + offset / 16000, endSeconds: startSeconds + (offset + 4096) / 16000,
        estimate: index === 0 ? estimate : estimateMonophonicPitch(frame, 16000) };
    });
    const harmonicPeaks = estimate ? analyzeSpectrum(samples, 16000).peaks.flatMap(peak => {
      const harmonicNumber = Math.round(peak.estimatedFrequencyHz / estimate.frequencyHz);
      if (harmonicNumber < 1 || harmonicNumber > 32) return [];
      const expectedFrequencyHz = harmonicNumber * estimate.frequencyHz;
      const centsFromHarmonic = 1200 * Math.log2(peak.estimatedFrequencyHz / expectedFrequencyHz);
      return Math.abs(centsFromHarmonic) <= 50 ? [{ ...peak, harmonicNumber, expectedFrequencyHz, centsFromHarmonic }] : [];
    }) : [];
    monophonicPitch = { estimate, frames, harmonicPeaks, harmonicToleranceCents: 50, sampleRate: 16000,
      frameSize: 4096, channelIndex: 0, startSeconds,
      limitation: "Up to 64 evenly spaced 256-ms frames of first-channel source audio resampled to 16 kHz; sparse sampling can miss short notes. Null means no reliable periodicity. Top-level estimate and harmonic peaks describe only the first frame; harmonic matches within 50 cents are not resonance or timbre classifications. Not polyphonic analysis or pitch correction." };
  }
  let spectrogram;
  if (includeSpectrogram) {
    const sampleRate = 48000, frameSize = 4096;
    if (windowSeconds < frameSize / sampleRate) throw new Error("spectrogram requires a full 4096-sample frame");
    const decoded = await run("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-ss", String(startSeconds), "-i", path, "-t", String(windowSeconds), "-map", "0:a:0", "-af", "pan=mono|c0=c0", "-ar", String(sampleRate), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], { ...limits, maxBuffer: 12 * 1024 * 1024, encoding: "buffer" });
    const count = Math.floor(decoded.stdout.length / 4);
    if (count < frameSize) throw new Error("spectrogram requires a full 4096-sample frame");
    const frameCount = Math.min(64, Math.floor(count / frameSize));
    const frames = Array.from({ length: frameCount }, (_, index) => {
      const offset = frameCount === 1 ? 0 : Math.floor(index * (count - frameSize) / (frameCount - 1));
      const samples = Float64Array.from({ length: frameSize }, (_, i) => decoded.stdout.readFloatLE((offset + i) * 4));
      return { startSeconds: startSeconds + offset / sampleRate,
        amplitudesDbfs: analyzeSpectrum(samples, sampleRate, { includeBins: true }).amplitudesDbfs };
    });
    spectrogram = { sampleRate, frameSize, frequencyResolutionHz: sampleRate / frameSize,
      channelIndex: 0, window: "periodic_hann", floorDbfs: -120, frames,
      limitation: "Up to 64 evenly spaced full frames of first-channel source audio resampled to 48 kHz; sparse sampling can miss transients. Bin amplitudes are not resonance classifications." };
  }
  let waveform;
  if (includeWaveform) {
    const sampleRate = 48000;
    const decoded = await run("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-ss", String(startSeconds), "-i", path, "-t", String(windowSeconds), "-map", "0:a:0", "-af", "pan=mono|c0=c0", "-ar", String(sampleRate), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], { ...limits, maxBuffer: 12 * 1024 * 1024, encoding: "buffer" });
    const sampleCount = Math.floor(decoded.stdout.length / 4);
    if (!sampleCount) throw new Error("waveform requires decoded source samples");
    const bucketCount = Math.min(1024, sampleCount);
    const buckets = Array.from({ length: bucketCount }, (_, index) => {
      const begin = Math.floor(index * sampleCount / bucketCount);
      const end = Math.floor((index + 1) * sampleCount / bucketCount);
      let min = Infinity, max = -Infinity, squares = 0;
      for (let i = begin; i < end; i++) {
        const value = decoded.stdout.readFloatLE(i * 4);
        if (!Number.isFinite(value)) throw new Error("waveform source contains nonfinite samples");
        min = Math.min(min, value); max = Math.max(max, value); squares += value * value;
      }
      return { startSeconds: startSeconds + begin / sampleRate, endSeconds: startSeconds + end / sampleRate,
        min, max, rms: Math.sqrt(squares / (end - begin)) };
    });
    waveform = { sampleRate, sampleCount, channelIndex: 0, buckets,
      limitation: "Complete first-channel source window resampled to 48 kHz, summarized into at most 1024 contiguous buckets. Not rendered Live audio or native-rate sample-accurate editing data." };
  }
  const after = await stat(path, { bigint: true });
  if (["dev", "ino", "size", "mtimeNs"].some(key => before[key] !== after[key])) throw new Error("audio source changed during analysis");
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return { sourcePath: path, scope: "source_audio", durationSeconds: length,
    sampleRate: Number(stream.sample_rate), channels: Number(stream.channels),
    window: { startSeconds, durationSeconds: windowSeconds },
    integratedLufs: finite(measured.input_i), truePeakDbtp: finite(measured.input_tp),
    loudnessRangeLu: finite(measured.input_lra), ...(spectrum ? { spectrum } : {}),
    ...(monophonicPitch ? { monophonicPitch } : {}), ...(spectrogram ? { spectrogram } : {}), ...(waveform ? { waveform } : {}) };
}
