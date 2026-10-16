import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";
import { getPrompt } from "../src/prompts.mjs";
import { mkdtempSync, writeFileSync, statSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = { stateVersion: 3, documentId: "doc", setFingerprint: "set", tempo: 120, isPlaying: true,
  recording: false, tracks: [{ name: "Bass", isGroup: false }] };
function harness() {
  const calls = [];
  const observed = structuredClone(source);
  const service = new ToolService({ bridge: { request: async (name, args) => {
    calls.push([name, args]);
    if (name === "get_audio_capture_source") return structuredClone(observed);
    if (name === "get_live_audio_capture") return { stateVersion: observed.stateVersion, captureId: "capture",
      status: "complete", fileUnchanged: true, file: { path: "/recorded.wav", size: 100, mtimeNs: 123 } };
    return { stateVersion: 4, captureId: "capture", status: name === "capture_live_audio" ? "recording" : "complete" };
  } } });
  return { service, calls, observed };
}

test("capture requires single-use confirmation bound to exact document, tempo and capture length", async () => {
  const { service, calls, observed } = harness();
  const args = { expectedStateVersion: 3, beats: 4, name: "Listen" };
  const plan = await service.call("capture_live_audio", args);
  assert.equal(plan.dryRun, true);
  assert.ok(!calls.some(([name]) => name === "capture_live_audio"));
  const confirmed = { ...args, dryRun: false, confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash };
  observed.tempo = 140;
  await assert.rejects(service.call("capture_live_audio", confirmed), /hash/);
  observed.tempo = 120;
  await assert.rejects(service.call("capture_live_audio", { ...confirmed, beats: 8 }), /hash/);
  assert.equal((await service.call("capture_live_audio", confirmed)).observed.status, "recording");
  await assert.rejects(service.call("capture_live_audio", confirmed));
});

test("capture bounds and finish cancel types are checked before native writes", async () => {
  const { service, calls } = harness();
  for (const beats of [0, 17, NaN, true])
    await assert.rejects(service.call("capture_live_audio", { expectedStateVersion: 3, beats, name: "Listen" }));
  await assert.rejects(service.call("capture_live_audio", { expectedStateVersion: 3, beats: 4, name: " " }));
  await assert.rejects(service.call("finish_live_audio_capture", { expectedStateVersion: 3, captureId: "capture", cancel: "yes" }));
  assert.ok(!calls.some(([name]) => ["capture_live_audio", "finish_live_audio_capture"].includes(name)));
});

test("finish preserves recorded files and binds exact captured identity and status", async () => {
  const { service, calls } = harness();
  const args = { expectedStateVersion: 3, captureId: "capture", cancel: false };
  const plan = await service.call("finish_live_audio_capture", args);
  const result = await service.call("finish_live_audio_capture", { ...args, dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash });
  assert.equal(result.observed.status, "complete");
  assert.equal(calls.at(-1)[1].before.file.path, "/recorded.wav");
  assert.equal(calls.at(-1)[1].cancel, false);
});

test("capture recovery is read-only and all-only; listening workflow requires stable completed audio", async () => {
  const { service } = harness();
  const route = createRouter(service);
  const tools = (await route({ id: 1, method: "tools/list" })).result.tools;
  assert.equal(tools.find(t => t.name === "get_live_audio_capture")?.annotations.readOnlyHint, true);
  assert.ok(tools.some(t => t.name === "capture_live_audio"));
  const core = (await createRouter(service, { toolProfile: "core" })({ id: 2, method: "tools/list" })).result.tools;
  assert.ok(!core.some(t => t.name === "capture_live_audio"));
  const text = getPrompt("listen-to-live-output", { request: "check this mix" }).messages[0].content.text;
  for (const word of ["capture_live_audio", "get_live_audio_capture", "finish_live_audio_capture", "analyze_audio_file",
    "fileUnchanged", "complete", "armed", "microphone", "cancel", "heard", "mono"])
    assert.ok(text.includes(word), word);
});

test("completed capture requires recorded duration evidence; an early stop remains partial", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-duration-"));
  try {
    const path = join(directory, "recorded.wav"), samples = 4000;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
    writeFileSync(path, wav);
    const info = statSync(path, { bigint: true });
    const capture = { stateVersion: 3, captureId: "capture", status: "file_ready", expectedDurationSeconds: 2,
      fileUnchanged: true, cleanupErrors: [], file: { path: realpathSync(path), size: Number(info.size), mtimeNs: String(info.mtimeNs) } };
    const service = new ToolService({ bridge: { request: async () => structuredClone(capture) } });
    const partial = await service.call("get_live_audio_capture", { captureId: "capture" });
    assert.equal(partial.status, "partial");
    assert.equal(partial.durationEvidence.durationSeconds, 0.5);
    capture.expectedDurationSeconds = 0.5;
    const complete = await service.call("get_live_audio_capture", { captureId: "capture" });
    assert.equal(complete.status, "complete");
    writeFileSync(path, Buffer.alloc(128));
    assert.notEqual((await service.call("get_live_audio_capture", { captureId: "capture" })).status, "complete");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
