import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAudioFile } from "../src/audio-analysis.mjs";

test("audio analysis rejects network sources and unbounded windows", async () => {
  await assert.rejects(() => analyzeAudioFile("https://example.com/audio.wav"), /absolute local/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { durationSeconds: 61 }), /durationSeconds/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { startSeconds: -1 }), /startSeconds/);
});
