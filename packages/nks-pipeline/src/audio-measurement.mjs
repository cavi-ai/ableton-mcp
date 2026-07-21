import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function lastNumber(text, pattern, label) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`missing ${label} measurement`);
  return Number(matches.at(-1)[1]);
}

export function parsePreviewMeasurement({ probeJson, ebur128Text }) {
  const probe = JSON.parse(probeJson);
  const stream = probe.streams?.[0];
  if (!stream) throw new Error("ffprobe returned no audio stream");
  return Object.freeze({
    durationSeconds: Number(probe.format?.duration),
    sampleRate: Number(stream.sample_rate),
    bitDepth: Number(stream.bits_per_raw_sample || stream.bits_per_sample),
    integratedLufs: lastNumber(ebur128Text, /\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g, "integrated loudness"),
    truePeakDbtp: lastNumber(ebur128Text, /\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dB(?:FS|TP)/g, "true peak")
  });
}

export async function measurePreview(path, { exec = execFileAsync } = {}) {
  const probe = await exec("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_streams", "-show_format", "-of", "json", path
  ]);
  const levels = await exec("ffmpeg", [
    "-hide_banner", "-nostats", "-i", path,
    "-filter_complex", "ebur128=peak=true", "-f", "null", "-"
  ]);
  return parsePreviewMeasurement({
    probeJson: probe.stdout,
    ebur128Text: `${levels.stdout ?? ""}\n${levels.stderr ?? ""}`
  });
}

function loudnormAnalysis(text) {
  const blocks = [...text.matchAll(/\{[^{}]*"input_i"[^{}]*\}/gs)];
  if (blocks.length === 0) throw new Error("ffmpeg loudnorm analysis was missing");
  return JSON.parse(blocks.at(-1)[0]);
}

export async function normalizePreview(inputPath, outputPath, { exec = execFileAsync } = {}) {
  const firstPass = await exec("ffmpeg", [
    "-hide_banner", "-nostats", "-i", inputPath,
    "-af", "loudnorm=I=-16:TP=-1:LRA=11:print_format=json",
    "-f", "null", "-"
  ]);
  const analysis = loudnormAnalysis(`${firstPass.stdout ?? ""}\n${firstPass.stderr ?? ""}`);
  const filter = [
    "loudnorm=I=-16:TP=-1:LRA=11",
    `measured_I=${Number(analysis.input_i)}`,
    `measured_TP=${Number(analysis.input_tp)}`,
    `measured_LRA=${Number(analysis.input_lra)}`,
    `measured_thresh=${Number(analysis.input_thresh)}`,
    `offset=${Number(analysis.target_offset)}`,
    "linear=true:print_format=summary"
  ].join(":");
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-nostats", "-i", inputPath,
    "-af", filter,
    "-ar", "48000", "-c:a", "pcm_s24le", outputPath
  ]);
  return Object.freeze({ inputPath, outputPath, analysis });
}
