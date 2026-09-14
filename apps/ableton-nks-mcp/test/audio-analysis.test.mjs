import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAudioFile } from "../src/audio-analysis.mjs";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";

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
