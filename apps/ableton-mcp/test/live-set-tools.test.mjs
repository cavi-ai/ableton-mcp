import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";
import { withRequestSignal } from "../src/request-context.mjs";

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

function launchFixture() {
  const appPath = "/Applications/Ableton Live 12 Suite.app";
  const context = { app: { path: appPath, executable: appPath + "/Contents/MacOS/Live", version: "12.4.6", binary: { size: 123, mtimeNs: "123" } }, running: [] };
  const file = { path: "/tmp/Launch.als", size: 100, mtimeMs: 200 };
  const calls = [];
  let live = null, bridgeReads = 0;
  const host = { launchContext: async () => structuredClone(context), fileInfo: async () => structuredClone(file),
    open: async (app, path) => { calls.push([app, path]); context.running = [{ pid: 42, path: context.app.executable }];
      live = { stateVersion: 1, setFingerprint: "launched", filePath: path, scriptDirectory }; } };
  const service = new ToolService({ liveSetHost: host, liveSetLaunchTimeoutMs: 0,
    bridge: { request: async () => { bridgeReads++; if (!live) throw new Error("bridge unavailable"); return live; } } });
  return { service, host, context, file, calls, reads: () => bridgeReads, setLive: value => { live = value; } };
}

test("launch mode plans without a bridge and confirms exact app/file identity before opening", async () => {
  const { service, calls, reads } = launchFixture();
  const args = { mode: "launch", path: "/tmp/Launch.als" };
  assert.deepEqual(validateToolArguments("open_live_set", args), args);
  const plan = await service.call("open_live_set", args);
  assert.equal(reads(), 0);assert.deepEqual(calls, []);
  const result = await service.call("open_live_set", { ...args, dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash });
  assert.equal(result.opened, true);assert.equal(result.launchRequested, true);
  assert.equal(result.observed.filePath, args.path);
  assert.deepEqual(calls, [["/Applications/Ableton Live 12 Suite.app", args.path]]);
  await assert.rejects(service.call("open_live_set", { ...args, dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }));
});

test("launch mode refuses running Live and stale app, file or source path without starting another instance", async () => {
  for (const change of ["running", "app", "file", "path"]) {
    const { service, context, file, calls } = launchFixture();
    const args = { mode: "launch", path: "/tmp/Launch.als" };
    const plan = await service.call("open_live_set", args);
    if (change === "running") context.running = [{ pid: 99, path: context.app.executable }];
    if (change === "app") context.app.binary.mtimeNs = "456";
    if (change === "file") file.mtimeMs = 300;
    if (change === "path") file.path = "/tmp/Other.als";
    await assert.rejects(service.call("open_live_set", { ...args, dryRun: false,
      confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }));
    assert.deepEqual(calls, [], change);
  }
});

test("launch receipt stays unverified when requested Set or process identity is not observed", async () => {
  for (const outcome of ["loading", "wrong-app"]) {
    const { service, host, context, calls, setLive } = launchFixture();
    host.open = async () => { calls.push("open");
      context.running = [{ pid: 42, path: outcome === "wrong-app" ? "/Other.app/Contents/MacOS/Live" : context.app.executable }];
      setLive(outcome === "loading" ? null : { stateVersion: 1, filePath: "/tmp/Launch.als" }); };
    const args = { mode: "launch", path: "/tmp/Launch.als" }, plan = await service.call("open_live_set", args);
    const result = await service.call("open_live_set", { ...args, dryRun: false,
      confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash });
    assert.equal(result.opened, false);assert.equal(result.launchRequested, true);
    assert.equal(calls.length, 1);
  }
});

test("cancelled launch never transmits the host action", async () => {
  const { service, calls } = launchFixture();
  const args = { mode: "launch", path: "/tmp/Launch.als" }, plan = await service.call("open_live_set", args);
  const abort = new AbortController();abort.abort();
  await assert.rejects(withRequestSignal(abort.signal, () => service.call("open_live_set", { ...args, dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash })));
  assert.deepEqual(calls, []);
});

test("a Live process appearing during the final file read prevents launch", async () => {
  const { service, host, context, file, calls } = launchFixture();
  let reads = 0;
  host.fileInfo = async () => {
    if (++reads === 3) context.running = [{ pid: 99, path: context.app.executable }];
    return structuredClone(file);
  };
  const args = { mode: "launch", path: file.path }, plan = await service.call("open_live_set", args);
  await assert.rejects(service.call("open_live_set", { ...args, dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }));
  assert.deepEqual(calls, []);
});

test("post-launch observation failures retain an explicit unknown startup receipt", async () => {
  for (const failure of ["dispatch", "observation"]) {
    const { service, host, calls } = launchFixture();
    const open = host.open;
    host.open = async (...args) => {
      await open(...args);
      if (failure === "dispatch") throw new Error("launch reply lost");
      host.launchContext = async () => { throw new Error("process observation unavailable"); };
    };
    const args = { mode: "launch", path: "/tmp/Launch.als" }, plan = await service.call("open_live_set", args);
    const result = await service.call("open_live_set", { ...args, dryRun: false,
      confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash });
    assert.equal(calls.length, 1);assert.equal(result.launchRequested, true);
    assert.equal(result.opened, false);assert.equal(result.startupStatus, "unverified");
    assert.equal(result.running, null);assert.ok(result.observationError);
    assert.match(result.limitation, /before retrying/);
  }
});


function saveAsFixture({ untitled = false } = {}) {
  let live = { stateVersion: 4, setFingerprint: "current", filePath: untitled ? "" : "/tmp/Old.als", scriptDirectory };
  const destination = { requestedPath: "/tmp/New.als", path: "/tmp/New Project/New.als", name: "New.als",
    parent: { path: "/tmp", dev: "1", ino: "2" }, project: null, createsProject: true };
  const calls = [];
  const host = { appPathFor: () => "/Applications/Live.app",
    saveAsDestination: async () => structuredClone(destination),
    fileInfo: async path => ({ path, size: 100, mtimeMs: 1 }),
    saveAs: async (app, target, { beforeSave }) => {
      calls.push("prepare");await beforeSave();calls.push("save");live = { ...live, filePath: target.path };
    } };
  const service = new ToolService({ bridge: { request: async () => live }, liveSetHost: host, liveSetSaveTimeoutMs: 0 });
  const args = { path: "/tmp/New.als", expectedStateVersion: 4, expectedSetFingerprint: "current" };
  const apply = plan => service.call("save_live_set", { ...args, dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash });
  return { service, host, calls, destination, args, apply, setLive: value => { live = value; }, live: () => live };
}

test("Save As supports untitled and named Sets with native path and disk verification", async () => {
  for (const untitled of [false, true]) {
    const f = saveAsFixture({ untitled });
    assert.deepEqual(validateToolArguments("save_live_set", f.args), f.args);
    const plan = await f.service.call("save_live_set", f.args);
    assert.equal(plan.plan.destination.path, f.destination.path);assert.deepEqual(f.calls, []);
    const result = await f.apply(plan);
    assert.equal(result.saved, true);assert.equal(result.observed.filePath, f.destination.path);
    assert.equal(result.after.path, f.destination.path);assert.deepEqual(f.calls, ["prepare", "save"]);
  }
});

test("Save As refuses destination changes before dispatch and native edits before Save", async () => {
  for (const change of ["destination", "native-during-dialog", "file-during-dialog"]) {
    const f = saveAsFixture(), plan = await f.service.call("save_live_set", f.args);
    if (change === "destination") f.destination.parent.ino = "3";
    else {
      const save = f.host.saveAs;
      f.host.saveAs = async (...args) => {
        if (change === "native-during-dialog") f.setLive({ ...f.live(), stateVersion: 5 });
        else f.host.fileInfo = async path => ({ path, size: 999, mtimeMs: 2 });
        return save(...args);
      };
    }
    if (change === "destination") await assert.rejects(f.apply(plan));
    else { const result = await f.apply(plan);assert.equal(result.saved, false);assert.ok(result.observationError); }
    assert.ok(!f.calls.includes("save"));
  }
});

test("Save As retains uncertainty after a lost reply, wrong native path, missing file, or zero-byte file", async () => {
  for (const outcome of ["lost-reply", "wrong-path", "missing", "empty"]) {
    const f = saveAsFixture(), plan = await f.service.call("save_live_set", f.args);
    const save = f.host.saveAs;
    f.host.saveAs = async (...args) => {
      await save(...args);
      if (outcome === "lost-reply") throw Error("reply lost");
      if (outcome === "wrong-path") f.setLive({ ...f.live(), filePath: "/tmp/Other.als" });
      if (outcome === "missing") f.host.fileInfo = async () => { throw Error("missing"); };
      if (outcome === "empty") f.host.fileInfo = async path => ({ path, size: 0, mtimeMs: 1 });
    };
    const result = await f.apply(plan);
    assert.equal(result.saved, false, outcome);assert.equal(result.pendingUserAction, true);
    assert.equal(result.saveAsRequested, true);assert.match(result.limitation, /inspect/i);
  }
});

test("cancelled Save As never dispatches or presses Save", async () => {
  const f = saveAsFixture(), plan = await f.service.call("save_live_set", f.args);
  const abort = new AbortController();abort.abort();
  await assert.rejects(withRequestSignal(abort.signal, () => f.apply(plan)));
  assert.deepEqual(f.calls, []);
});
