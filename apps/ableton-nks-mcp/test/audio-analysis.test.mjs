import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAudioFile } from "../src/audio-analysis.mjs";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";

test("audio analysis rejects network sources and unbounded windows", async () => {
  await assert.rejects(() => analyzeAudioFile("https://example.com/audio.wav"), /absolute local/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { durationSeconds: 61 }), /durationSeconds/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { startSeconds: -1 }), /startSeconds/);
});

test("MCP audio analysis validates bounded windows before running analysis", async () => {
  const route = createRouter(new ToolService({}));
  const listed = await route({ id: 1, method: "tools/list" });
  assert.ok(listed.result.tools.some(tool => tool.name === "analyze_audio_file"));
  for (const arguments_ of [
    { sourcePath: "/audio.wav", durationSeconds: 61 },
    { sourcePath: "/audio.wav", startSeconds: -1 },
    { sourcePath: "/audio.wav", durationSeconds: "10" }
  ]) {
    const reply = await route({ id: 2, method: "tools/call", params: { name: "analyze_audio_file", arguments: arguments_ } });
    assert.equal(reply.error.code, -32602);
  }
  const remote = await route({ id: 3, method: "tools/call", params: { name: "analyze_audio_file", arguments: { sourcePath: "https://example.com/a.wav" } } });
  assert.match(remote.error.message, /absolute local/);
});
