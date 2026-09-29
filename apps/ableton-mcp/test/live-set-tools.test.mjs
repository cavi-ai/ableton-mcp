import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";

const scriptDirectory = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/MIDI Remote Scripts/CaviMcpBridge";

test("Set file tools require exact identity guards and declare disk-impact annotations", () => {
  assert.deepEqual(validateToolArguments("open_live_set", { path: "/tmp/Song.als",
    expectedStateVersion: 4, expectedSetFingerprint: "set:old" }), { path: "/tmp/Song.als",
    expectedStateVersion: 4, expectedSetFingerprint: "set:old" });
  assert.throws(() => validateToolArguments("open_live_set", { path: "/tmp/Song.als",
    expectedStateVersion: 4 }), /expectedSetFingerprint/);
  assert.throws(() => validateToolArguments("save_live_set", { expectedStateVersion: 4 }), /expectedSetFingerprint/);
  for (const name of ["open_live_set", "save_live_set"]) {
    assert.equal(toolContracts[name].annotations.readOnlyHint, false);
    assert.equal(toolContracts[name].annotations.destructiveHint, true);
  }
});

test("open_live_set confirms the current Set identity and verifies the requested Set loaded", async () => {
  let live = { stateVersion: 4, setFingerprint: "old", filePath: "/tmp/Old.als", scriptDirectory };
  const opened = [];
  const host = { appPathFor: () => "/Applications/Ableton Live 12 Suite.app",
    fileInfo: async () => ({ path: "/tmp/New.als", size: 100, mtimeMs: 200 }),
    open: async (app, path) => { opened.push([app, path]); live = { ...live, stateVersion: 1, setFingerprint: "new", filePath: path }; } };
  const service = new ToolService({ bridge: { request: async () => live }, liveSetHost: host });
  const args = { path: "/tmp/New.als", expectedStateVersion: 4, expectedSetFingerprint: "old" };
  const dry = await service.call("open_live_set", args);
  assert.equal(dry.plan.path, "/tmp/New.als");
  assert.equal(opened.length, 0);
  const result = await service.call("open_live_set", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.opened, true);
  assert.equal(result.observed.filePath, "/tmp/New.als");
  assert.deepEqual(opened, [["/Applications/Ableton Live 12 Suite.app", "/tmp/New.als"]]);
});

test("open_live_set refuses changed current state and never claims a pending UI prompt as opened", async () => {
  let live = { stateVersion: 4, setFingerprint: "old", filePath: "/tmp/Old.als", scriptDirectory };
  let opens = 0;
  const host = { appPathFor: () => "/Applications/Ableton Live 12 Suite.app",
    fileInfo: async () => ({ path: "/tmp/New.als", size: 100, mtimeMs: 200 }),
    open: async () => { opens++; } };
  const service = new ToolService({ bridge: { request: async () => live }, liveSetHost: host, liveSetOpenTimeoutMs: 0 });
  const args = { path: "/tmp/New.als", expectedStateVersion: 4, expectedSetFingerprint: "old" };
  const dry = await service.call("open_live_set", args);
  live = { ...live, setFingerprint: "changed" };
  await assert.rejects(() => service.call("open_live_set", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash }), /Set changed/);
  assert.equal(opens, 0);
  live = { ...live, setFingerprint: "old" };
  const pending = await service.call("open_live_set", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(pending.opened, false);
  assert.equal(pending.pendingUserAction, true);
  assert.equal(opens, 1);
});

test("save_live_set confirms the named current Set and proves an on-disk write", async () => {
  const live = { stateVersion: 4, setFingerprint: "current", filePath: "/tmp/Song.als", scriptDirectory };
  let mtimeMs = 100;
  let saves = 0;
  const host = { appPathFor: () => "/Applications/Ableton Live 12 Suite.app",
    fileInfo: async () => ({ path: "/tmp/Song.als", size: 1000, mtimeMs }),
    save: async () => { saves++; mtimeMs = 200; } };
  const service = new ToolService({ bridge: { request: async () => live }, liveSetHost: host });
  const args = { expectedStateVersion: 4, expectedSetFingerprint: "current" };
  const dry = await service.call("save_live_set", args);
  assert.equal(dry.plan.path, "/tmp/Song.als");
  assert.equal(saves, 0);
  const result = await service.call("save_live_set", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.saved, true);
  assert.equal(result.pendingUserAction, false);
  assert.equal(result.after.mtimeMs, 200);
  assert.equal(saves, 1);
});

test("save_live_set reports a pending dialog instead of claiming an unchanged file was saved", async () => {
  const live = { stateVersion: 4, setFingerprint: "current", filePath: "/tmp/Song.als", scriptDirectory };
  const host = { appPathFor: () => "/Applications/Ableton Live 12 Suite.app",
    fileInfo: async () => ({ path: "/tmp/Song.als", size: 1000, mtimeMs: 100 }),
    save: async () => {} };
  const service = new ToolService({ bridge: { request: async () => live }, liveSetHost: host,
    liveSetSaveTimeoutMs: 0 });
  const args = { expectedStateVersion: 4, expectedSetFingerprint: "current" };
  const dry = await service.call("save_live_set", args);
  const result = await service.call("save_live_set", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.saved, false);
  assert.equal(result.pendingUserAction, true);
});

test("save_live_set refuses an unnamed Set rather than opening Save As", async () => {
  const service = new ToolService({ bridge: { request: async () => ({ stateVersion: 4,
    setFingerprint: "untitled", filePath: "", scriptDirectory }) },
  liveSetHost: { appPathFor: () => "/Applications/Ableton Live 12 Suite.app" } });
  await assert.rejects(() => service.call("save_live_set", {
    expectedStateVersion: 4, expectedSetFingerprint: "untitled" }), /named Live Set/);
});
