import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolResult } from "../src/tool-validation.mjs";

const source = readFileSync(new URL("../src/live-app-raise.js", import.meta.url), "utf8");
const appPath = "/Applications/Ableton Live 12 Suite.app";
const editor = { pid: 7, name: "Editor", bundleIdentifier: "com.example.editor" };
const live = { pid: 42, name: "Live", bundleIdentifier: "com.ableton.live" };

function desktop({ path = appPath, front = 7, shown = false, raises = true } = {}) {
  const activated = [];
  const app = pid => pid === 42 ? { processIdentifier: 42, localizedName: "Live", bundleIdentifier: "com.ableton.live" }
    : { processIdentifier: 7, localizedName: "Editor", bundleIdentifier: "com.example.editor" };
  const native = Object.assign(value => value, {
    NSRunningApplication: { runningApplicationWithProcessIdentifier: () => ({ bundleIdentifier: "com.ableton.live", bundleURL: { path } }) },
    NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return app(front); } } },
    CGWindowListCopyWindowInfo: () => shown ? [{ kCGWindowOwnerPID: 42, kCGWindowNumber: 212685, kCGWindowLayer: 0, kCGWindowIsOnscreen: true }] : []
  });
  const run = vm.runInNewContext(`${source}\nrun`, { $: native, delay() {},
    Application: target => ({ activate() { activated.push(target);if (raises) { front = 42;shown = true; } } }),
    ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value } });
  return { activated, execute: input => JSON.parse(run([JSON.stringify({ pid: 42, appPath, ...input })])) };
}

test("raising activates the exact Live app once and verifies it is frontmost with a window on screen", () => {
  const behind = desktop();
  assert.deepEqual(behind.execute({}), { raised: true, activations: 1, previous: editor, frontmost: live, windowIds: [212685] });
  assert.deepEqual(behind.activated, [appPath]);
});

test("Live already in front is not activated, and observe never activates", () => {
  const shown = desktop({ front: 42, shown: true });
  assert.deepEqual(shown.execute({}), { raised: true, activations: 0, previous: live, frontmost: live, windowIds: [212685] });
  const behind = desktop();
  assert.equal(behind.execute({ action: "observe" }).raised, false);
  assert.deepEqual([...shown.activated, ...behind.activated], []);
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
