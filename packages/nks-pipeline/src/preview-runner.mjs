import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const loudnormFilter = "loudnorm=I=-16:TP=-1:LRA=11";

async function command(binary, args, timeoutMs) {
  return execFileAsync(binary, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}

function parseLoudnorm(text) {
  const blocks = [...text.matchAll(/\{[^{}]*"input_i"[^{}]*\}/gs)];
  if (!blocks.length) throw new Error("ffmpeg loudnorm measurements are missing");
  return JSON.parse(blocks.at(-1)[0]);
}

async function measure(path, timeoutMs) {
  const [probe, loudness] = await Promise.all([
    command("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_streams", "-show_format", "-of", "json", path], timeoutMs),
    command("ffmpeg", ["-hide_banner", "-nostats", "-i", path,
      "-af", `${loudnormFilter}:print_format=json`, "-f", "null", "-"], timeoutMs)
  ]);
  const data = JSON.parse(probe.stdout);
  const stream = data.streams?.[0];
  if (!stream) throw new Error("preview has no audio stream");
  const analysis = parseLoudnorm(`${loudness.stdout}\n${loudness.stderr}`);
  return { measurement: {
    durationSeconds: Number(data.format?.duration),
    sampleRate: Number(stream.sample_rate),
    bitDepth: Number(stream.bits_per_raw_sample || stream.bits_per_sample),
    integratedLufs: Number(analysis.input_i),
    truePeakDbtp: Number(analysis.input_tp)
  }, analysis };
}

export function validatePreviewMeasurement(value) {
  const findings = [];
  if (!Number.isFinite(value?.durationSeconds)) findings.push("invalid_duration");
  else if (Math.abs(value.durationSeconds - 12) > 0.1) findings.push("duration_not_12_seconds");
  if (value?.sampleRate !== 48000) findings.push("sample_rate_not_48000");
  if (value?.bitDepth !== 24) findings.push("bit_depth_not_24");
  if (!Number.isFinite(value?.integratedLufs) || value.integratedLufs <= -60) findings.push("silence_or_invalid_loudness");
  else if (Math.abs(value.integratedLufs + 16) > 0.5) findings.push("loudness_not_-16_lufs");
  if (!Number.isFinite(value?.truePeakDbtp)) findings.push("invalid_true_peak");
  else if (value.truePeakDbtp > -1) findings.push("true_peak_above_-1_dbtp");
  return { ok: findings.length === 0, findings };
}

function measuredFilter(analysis) {
  const fields = {
    measured_I: analysis.input_i,
    measured_TP: analysis.input_tp,
    measured_LRA: analysis.input_lra,
    measured_thresh: analysis.input_thresh,
    offset: analysis.target_offset
  };
  for (const [name, value] of Object.entries(fields)) {
    if (!Number.isFinite(Number(value))) throw new Error(`invalid loudnorm ${name}`);
  }
  return `${loudnormFilter}:${Object.entries(fields).map(([name, value]) => `${name}=${Number(value)}`).join(":")}:linear=true`;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function runPreview({ rawPath, finalPath, timeoutMs = 120000 }) {
  if (typeof rawPath !== "string" || !rawPath || typeof finalPath !== "string" || !finalPath)
    throw new Error("rawPath and finalPath are required");
  if (resolve(rawPath) === resolve(finalPath)) throw new Error("rawPath and finalPath must differ");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");

  const raw = await measure(rawPath, timeoutMs);
  if (!Number.isFinite(raw.measurement.durationSeconds) || Math.abs(raw.measurement.durationSeconds - 12) > 0.1)
    throw new Error("preview rejected: duration_not_12_seconds");
  if (!Number.isFinite(raw.measurement.integratedLufs) || raw.measurement.integratedLufs <= -60)
    throw new Error("preview rejected: silence_or_invalid_loudness");

  await mkdir(dirname(finalPath), { recursive: true });
  const temporaryPath = resolve(dirname(finalPath), `.${basename(finalPath)}.${randomBytes(8).toString("hex")}.tmp.wav`);
  try {
    await command("ffmpeg", ["-y", "-hide_banner", "-nostats", "-i", rawPath,
      "-af", measuredFilter(raw.analysis), "-ar", "48000", "-c:a", "pcm_s24le", "-f", "wav", temporaryPath], timeoutMs);
    const { measurement } = await measure(temporaryPath, timeoutMs);
    const validation = validatePreviewMeasurement(measurement);
    if (!validation.ok) throw new Error(`preview rejected: ${validation.findings.join(", ")}`);
    const digest = await sha256(temporaryPath);
    await link(temporaryPath, finalPath);
    return { finalPath, measurement, sha256: digest };
  } finally {
    await unlink(temporaryPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
