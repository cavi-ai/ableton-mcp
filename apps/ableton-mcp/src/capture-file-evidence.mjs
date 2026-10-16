import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";

const run = promisify(execFile);
const cache = new Map();
async function unchanged(file) {
  if (await realpath(file.path) !== file.path) return false;
  const info = await stat(file.path, { bigint: true });
  return info.isFile() && String(info.size) === String(file.size) && String(info.mtimeNs) === String(file.mtimeNs);
}

export async function capturedFileEvidence(capture) {
  if (capture.status !== "file_ready") return capture;
  try {
    if (!capture.fileUnchanged || capture.cleanupErrors.length || !await unchanged(capture.file))
      return { ...capture, status: "unverified", fileUnchanged: false };
    const key = JSON.stringify(capture.file);
    let measured = cache.get(key);
    if (!measured) {
      const result = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe",
        "-show_entries", "format=duration:stream=codec_type,sample_rate,channels", "-of", "json", capture.file.path],
      { timeout: 10000, maxBuffer: 65536 });
      const metadata = JSON.parse(result.stdout);
      const stream = metadata.streams?.find(stream => stream.codec_type === "audio");
      measured = { durationSeconds: Number(metadata.format?.duration), sampleRate: Number(stream?.sample_rate), channels: Number(stream?.channels) };
      if (!Number.isFinite(measured.durationSeconds) || measured.durationSeconds <= 0 || !Number.isFinite(measured.sampleRate) ||
          measured.sampleRate <= 0 || !Number.isInteger(measured.channels) || measured.channels < 1)
        throw new Error("recorded audio has invalid duration or stream metadata");
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(key, measured);
    }
    if (!await unchanged(capture.file)) return { ...capture, status: "unverified", fileUnchanged: false };
    const toleranceSeconds = Math.max(0.002, 2 / measured.sampleRate);
    const matches = Number.isFinite(capture.expectedDurationSeconds) &&
      Math.abs(measured.durationSeconds - capture.expectedDurationSeconds) <= toleranceSeconds;
    return { ...capture, status: matches ? "complete" : "partial",
      durationEvidence: { ...measured, expectedDurationSeconds: capture.expectedDurationSeconds, toleranceSeconds } };
  } catch (error) {
    return { ...capture, status: "unverified", verificationError: `Cannot verify recorded audio metadata: ${error.message.slice(0, 300)}` };
  }
}
