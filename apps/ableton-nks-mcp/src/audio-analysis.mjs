import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { analyzeSpectrum } from "./audio-spectrum.mjs";

const run = promisify(execFile);
const limits = { timeout: 30000, maxBuffer: 2 * 1024 * 1024 };

export async function analyzeAudioFile(sourcePath, { startSeconds = 0, durationSeconds = 10, includeSpectrum = false } = {}) {
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) throw new Error("source must be an absolute local file path");
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error("startSeconds must be finite and nonnegative");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60) throw new Error("durationSeconds must be greater than zero and at most 60");
  if (typeof includeSpectrum !== "boolean") throw new Error("includeSpectrum must be boolean");
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
  const after = await stat(path, { bigint: true });
  if (["dev", "ino", "size", "mtimeNs"].some(key => before[key] !== after[key])) throw new Error("audio source changed during analysis");
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return { sourcePath: path, scope: "source_audio", durationSeconds: length,
    sampleRate: Number(stream.sample_rate), channels: Number(stream.channels),
    window: { startSeconds, durationSeconds: windowSeconds },
    integratedLufs: finite(measured.input_i), truePeakDbtp: finite(measured.input_tp),
    loudnessRangeLu: finite(measured.input_lra), ...(spectrum ? { spectrum } : {}) };
}
