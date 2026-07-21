import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePreviewMeasurement } from "./preview-policy.mjs";
import { measurePreview, normalizePreview } from "./audio-measurement.mjs";

export function planPreviewCommands({ liveSetPath, rawPath, normalizedPath }) {
  return Object.freeze({
    render: ["ableton-live", "--headless", liveSetPath, "--render-output", rawPath],
    normalize: [
      "ffmpeg", "-y", "-i", rawPath,
      "-af", "loudnorm=I=-16:TP=-1:LRA=11",
      "-ar", "48000", "-c:a", "pcm_s24le", normalizedPath
    ],
    measure: ["ffprobe", "-v", "error", "-show_streams", "-show_format", normalizedPath]
  });
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("preview render timed out")), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

export async function runPreview({
  render,
  normalize = normalizePreview,
  measure = measurePreview,
  rawPath,
  finalPath,
  timeoutMs = 120000
}) {
  await mkdir(dirname(finalPath), { recursive: true });
  await withTimeout(Promise.resolve().then(() => render(rawPath)), timeoutMs);

  const rawMeasurement = await measure(rawPath);
  if (rawMeasurement.integratedLufs < -60) throw new Error("preview rejected: silence");

  const temporaryPath = `${finalPath}.tmp.wav`;
  await normalize(rawPath, temporaryPath);
  const measurement = await measure(temporaryPath);
  const validation = validatePreviewMeasurement(measurement);
  if (!validation.ok) throw new Error(`preview rejected: ${validation.findings.join(", ")}`);

  await rename(temporaryPath, finalPath);
  return Object.freeze({ finalPath, measurement, validation });
}
