import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

const run = promisify(execFile);
const limits = { timeout: 30000, maxBuffer: 2 * 1024 * 1024 };

export async function analyzeAudioFile(sourcePath, { startSeconds = 0, durationSeconds = 10 } = {}) {
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) throw new Error("source must be an absolute local file path");
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error("startSeconds must be finite and nonnegative");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60) throw new Error("durationSeconds must be greater than zero and at most 60");
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
  const after = await stat(path, { bigint: true });
  if (["dev", "ino", "size", "mtimeNs"].some(key => before[key] !== after[key])) throw new Error("audio source changed during analysis");
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return { sourcePath: path, scope: "source_audio", durationSeconds: length,
    sampleRate: Number(stream.sample_rate), channels: Number(stream.channels),
    window: { startSeconds, durationSeconds: windowSeconds },
    integratedLufs: finite(measured.input_i), truePeakDbtp: finite(measured.input_tp),
    loudnessRangeLu: finite(measured.input_lra) };
}
