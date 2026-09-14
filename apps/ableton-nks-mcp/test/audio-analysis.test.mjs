import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAudioFile } from "../src/audio-analysis.mjs";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("generated source audio supports pitch through the MCP router", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-pitch-"));
  const run = promisify(execFile);
  try {
    const sourcePath = join(directory, "tone.wav");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=1", sourcePath]);
    const route = createRouter(new ToolService({}));
    const reply = await route({ id: 1, method: "tools/call", params: {
      name: "analyze_audio_file", arguments: { sourcePath, includePitch: true, includeSpectrum: true }
    } });
    assert.equal(reply.error, undefined);
    const measurement = reply.result.structuredContent;
    assert.ok(Math.abs(measurement.monophonicPitch.estimate.frequencyHz - 440) < 1);
    assert.equal(measurement.monophonicPitch.estimate.pitchReference.noteName, "A4");
    assert.equal(measurement.sampleRate, 96000);
    assert.equal(measurement.spectrum.sampleRate, 96000);
    assert.equal(measurement.monophonicPitch.sampleRate, 16000);
    await assert.rejects(() => analyzeAudioFile(sourcePath, { includePitch: true, durationSeconds: 0.1 }), /0.256-second/);
    const silencePath = join(directory, "silence.wav");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "1", silencePath]);
    const silence = await analyzeAudioFile(silencePath, { includePitch: true });
    assert.equal(silence.monophonicPitch.estimate, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audio analysis rejects network sources and unbounded windows", async () => {
  await assert.rejects(() => analyzeAudioFile("https://example.com/audio.wav"), /absolute local/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { durationSeconds: 61 }), /durationSeconds/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { startSeconds: -1 }), /startSeconds/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { includeSpectrum: "yes" }), /includeSpectrum/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { includePitch: "yes" }), /includePitch/);
});

test("MCP audio analysis validates bounded windows before running analysis", async () => {
  const route = createRouter(new ToolService({}));
  const listed = await route({ id: 1, method: "tools/list" });
  assert.ok(listed.result.tools.some(tool => tool.name === "analyze_audio_file"));
  for (const arguments_ of [
    { sourcePath: "/audio.wav", durationSeconds: 61 },
    { sourcePath: "/audio.wav", startSeconds: -1 },
    { sourcePath: "/audio.wav", durationSeconds: "10" },
    { sourcePath: "/audio.wav", includeSpectrum: "yes" },
    { sourcePath: "/audio.wav", includePitch: "yes" }
  ]) {
    const reply = await route({ id: 2, method: "tools/call", params: { name: "analyze_audio_file", arguments: arguments_ } });
    assert.equal(reply.error.code, -32602);
  }
  const remote = await route({ id: 3, method: "tools/call", params: { name: "analyze_audio_file", arguments: { sourcePath: "https://example.com/a.wav" } } });
  assert.match(remote.error.message, /absolute local/);
});

test("clip analysis reports unavailable source rather than guessing a path", async () => {
  const service = new ToolService({ bridge: { async request(method, params) {
    assert.equal(method, "get_audio_clip_state");
    assert.deepEqual(params, { trackId: "track-0", clipId: "track-0:clip-0" });
    return { stateVersion: 1, ...params, source: { path: null, lengthSamples: -1 } };
  } } });
  await assert.rejects(() => service.call("analyze_audio_clip", {
    trackId: "track-0", clipId: "track-0:clip-0"
  }), /source file is unavailable/);
});
