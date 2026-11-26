import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MacLiveSetHost } from "../src/live-set-host.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolResult } from "../src/tool-validation.mjs";

const source = readFileSync(new URL("../src/live-app-raise.js", import.meta.url), "utf8");
const appPath = "/Applications/Ableton Live 12 Suite.app";
const editor = { pid: 7, name: "Editor", bundleIdentifier: "com.example.editor" };
const live = { pid: 42, name: "Live", bundleIdentifier: "com.ableton.live" };

function desktop({ path = appPath, front = 7, shown = false, raises = true, systemEventsDenied = false } = {}) {
  const activated = [];
  function activate(target) {
    activated.push(target);
    if (raises) { front = 42;shown = true; }
  }
  const systemProcess = pid => pid === 42 ? { unixId: () => 42, name: () => "Live", bundleIdentifier: () => "com.ableton.live" }
    : { unixId: () => 7, name: () => "Editor", bundleIdentifier: () => "com.example.editor" };
  const events = { applicationProcesses: { whose: query => () => {
    if (systemEventsDenied) throw new Error("Not authorized to send Apple events.");
    return query.frontmost === true ? [systemProcess(front)] : [];
  } } };
  const native = Object.assign(value => value, {
    NSRunningApplication: { runningApplicationWithProcessIdentifier: () => ({ isNil: () => false, bundleIdentifier: "com.ableton.live", bundleURL: { path } }) },
    NSAppleEventSendDefaultOptions: 3,
    NSAppleEventDescriptor: {
      descriptorWithProcessIdentifier: pid => ({ pid }),
      appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(eventClass, eventId, target) {
        return { sendEventWithOptionsTimeoutError() {
          assert.equal(eventClass, 0x6d697363);
          assert.equal(eventId, 0x61637476);
          activate(target.pid);
          return { isNil: () => false, paramDescriptorForKeyword: () => ({ int32Value: 0 }) };
        } };
      }
    },
    // A polling script's NSWorkspace keeps the app it read first.
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 7, localizedName: "Editor", bundleIdentifier: "com.example.editor" } } },
    CGWindowListCopyWindowInfo: () => shown ? [{ kCGWindowOwnerPID: 42, kCGWindowNumber: 212685, kCGWindowLayer: 0, kCGWindowIsOnscreen: true }] : []
  });
  const run = vm.runInNewContext(`${source}\nrun`, { $: native, delay() {},
    Application: name => { assert.equal(name, "System Events"); return events; },
    Ref: () => [],
    ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value } });
  return { activated, execute: input => JSON.parse(run([JSON.stringify({ pid: 42, appPath, ...input })])) };
}

test("raising activates the exact Live app once and verifies it is frontmost with a window on screen", () => {
  const behind = desktop();
  assert.deepEqual(behind.execute({}), { raised: true, activations: 1, previous: editor, frontmost: live, windowIds: [212685] });
  assert.deepEqual(behind.activated, [42]);
});

test("Live already in front is not activated, and observe never activates", () => {
  const shown = desktop({ front: 42, shown: true });
  assert.deepEqual(shown.execute({}), { raised: true, activations: 0, previous: live, frontmost: live, windowIds: [212685] });
  const behind = desktop();
  assert.equal(behind.execute({ action: "observe" }).raised, false);
  assert.deepEqual([...shown.activated, ...behind.activated], []);
});

test("System Events denial is reported before sending a Live activation", () => {
  const denied = desktop({ front: 42, shown: true, systemEventsDenied: true });
  assert.throws(() => denied.execute({}), /System Events.*not authorized to send Apple events/i);
  assert.deepEqual(denied.activated, []);
});

test("a refused activation reports raised false after two attempts, and another app path is refused", () => {
  const refused = desktop({ raises: false }), result = refused.execute({});
  assert.deepEqual([result.raised, result.activations, refused.activated.length], [false, 2, 2]);
  assert.throws(() => desktop({ path: "/Applications/Other.app" }).execute({}), /exact running Live/);
});

function serviceFixture() {
  const state = { pid: 42 }, calls = [];
  const liveSetHost = { raise: async ({ observe = false } = {}) => {
    calls.push(observe ? "observe" : "raise");
    return { pid: state.pid, appPath, raised: !observe, activations: observe ? 0 : 1, previous: editor,
      frontmost: observe ? editor : live, windowIds: observe ? [] : [212685] };
  } };
  const service = new ToolService({ liveSetHost, bridge: { request: async () => { throw new Error("bridge unavailable"); } } });
  return { service, state, calls };
}

test("raise_live plans without activating and raises once on confirmation, without a bridge", async () => {
  const { service, calls } = serviceFixture();
  const plan = validateToolResult("raise_live", await service.call("raise_live", {}), {});
  assert.equal(plan.plan.method, "raise_live");assert.equal(plan.plan.pid, 42);assert.deepEqual(calls, ["observe"]);
  const execute = { dryRun: false, confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash };
  const result = validateToolResult("raise_live", await service.call("raise_live", execute), execute);
  assert.equal(result.raised, true);assert.equal(result.operationOutcome.status, "applied");
  assert.deepEqual(calls, ["observe", "observe", "raise"]);
  await assert.rejects(service.call("raise_live", execute));
  assert.equal(calls.filter(call => call === "raise").length, 1);
});

test("a changed Live process rejects the confirmed raise before activation", async () => {
  const { service, state, calls } = serviceFixture();
  const plan = await service.call("raise_live", {});
  state.pid = 43;
  await assert.rejects(service.call("raise_live", { dryRun: false, confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }));
  assert.deepEqual(calls, ["observe", "observe"]);
});

test("raise_live refuses a replacement that appears after confirmation and before dispatch", async () => {
  for (const replacement of [
    { pid: 43, path: appPath },
    { pid: 42, path: "/Applications/Other Live.app" }
  ]) {
    const activations = [];
    let observations = 0;
    const host = new MacLiveSetHost({ platform: "darwin", run: async (command, args) => {
      if (command === "/bin/ps") {
        const current = ++observations <= 2 ? { pid: 42, path: appPath } : replacement;
        return { stdout: ` ${current.pid} ${current.path}/Contents/MacOS/Live\n` };
      }
      const input = JSON.parse(args.at(-1));
      if (!input.action) activations.push(input);
      return { stdout: JSON.stringify({ raised: !input.action }) };
    } });
    const service = new ToolService({ liveSetHost: host });
    const plan = await service.call("raise_live", {});
    const result = await service.call("raise_live", {
      dryRun: false, confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash
    });
    assert.equal(result.raised, false);
    assert.deepEqual(activations, []);
  }
});
