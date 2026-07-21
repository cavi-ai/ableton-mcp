import test from "node:test";
import assert from "node:assert/strict";
import { parsePreviewMeasurement, measurePreview, normalizePreview } from "../src/audio-measurement.mjs";

test("parsePreviewMeasurement combines ffprobe and ebur128 evidence", () => {
  const measurement = parsePreviewMeasurement({
    probeJson: JSON.stringify({
      streams: [{ sample_rate: "48000", bits_per_raw_sample: "24" }],
      format: { duration: "12.000000" }
    }),
    ebur128Text: "Integrated loudness:\n    I:         -16.0 LUFS\nTrue peak:\n    Peak:       -1.2 dBFS"
  });
  assert.deepEqual(measurement, {
    durationSeconds: 12,
    sampleRate: 48000,
    bitDepth: 24,
    integratedLufs: -16,
    truePeakDbtp: -1.2
  });
});

test("measurePreview invokes ffprobe and ffmpeg without modifying input", async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    return command === "ffprobe"
      ? { stdout: '{"streams":[{"sample_rate":"48000","bits_per_raw_sample":"24"}],"format":{"duration":"12"}}', stderr: "" }
      : { stdout: "", stderr: "I: -16.0 LUFS Peak: -1.1 dBFS" };
  };
  const result = await measurePreview("/tmp/preview.wav", { exec });
  assert.equal(result.truePeakDbtp, -1.1);
  assert.equal(calls[0][0], "ffprobe");
  assert.equal(calls[1][0], "ffmpeg");
  assert.equal(calls[1][1].includes("-f"), true);
  assert.equal(calls[1][1].at(-1), "-");
});

test("normalizePreview performs measured two-pass loudnorm to 48 kHz 24-bit PCM", async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (calls.length === 1) {
      return {
        stdout: "",
        stderr: '[Parsed_loudnorm] {"input_i":"-22.0","input_tp":"-3.0","input_lra":"4.0","input_thresh":"-32.0","target_offset":"0.1"}'
      };
    }
    return { stdout: "", stderr: "" };
  };
  await normalizePreview("/tmp/raw.wav", "/tmp/final.wav", { exec });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].some((value) => value.includes("print_format=json")), true);
  assert.equal(calls[1][1].some((value) => value.includes("measured_I=-22")), true);
  assert.deepEqual(calls[1][1].slice(-5), ["-ar", "48000", "-c:a", "pcm_s24le", "/tmp/final.wav"]);
});
