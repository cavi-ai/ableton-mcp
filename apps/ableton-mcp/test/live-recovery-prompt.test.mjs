import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MacLiveSetHost } from "../src/live-set-host.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments, validateToolResult } from "../src/tool-validation.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";

const source = readFileSync(new URL("../src/live-recovery-prompt.js", import.meta.url), "utf8");
const appPath = "/Applications/Ableton Live 12 Suite.app";
const message = "Live unexpectedly quit while you were working on the Live Set \"Untitled.\" Would you like to recover your work?";

// Native accessibility tree as Live 12 exposes it: a message group plus an empty text element.
function nativePrompt({ path = appPath, text = message, closes = true, pressCode = 0 } = {}) {
  const pressed = [], array = items => ({ count: String(items.length), objectAtIndex: i => items[i] });
  const button = name => ({ AXRole: "AXButton", AXDescription: name, AXEnabled: true });
  const group = { AXRole: "AXGroup", AXChildren: array([{ AXRole: "AXStaticText", AXValue: text }, button("No"), button("Yes")]) };
  const dialog = { AXSubrole: "AXDialog", AXChildren: array([group, { AXRole: "AXStaticText", AXValue: "" }]) };
  let open = true, clock = 0;
  const root = { get AXFocusedWindow() { return open ? dialog : { AXSubrole: "AXStandardWindow", AXChildren: array([]) }; } };
  const native = Object.assign(value => value, {
    NSRunningApplication: { runningApplicationWithProcessIdentifier: () => ({ bundleIdentifier: "com.ableton.live", bundleURL: { path } }) },
    AXUIElementCreateApplication: () => root, AXUIElementCreateSystemWide: () => ({}), AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, key, ref) => { if (element[key] === undefined) return -25212; ref[0] = element[key]; return 0; },
    AXUIElementPerformAction: element => { pressed.push(element.AXDescription); if (closes) open = false; return pressCode; }
  });
  const run = vm.runInNewContext(`${source}\nrun`, { $: native, Ref: () => [], Date: { now: () => clock },
    delay: seconds => { clock += seconds * 1000; },
    ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value } });
  return { pressed, execute: input => JSON.parse(run([JSON.stringify({ pid: 42, appPath, ...input })])) };
}

test("the recovery prompt is read with its Set name and no button pressed", () => {
  const native = nativePrompt();
  assert.deepEqual(native.execute({}), { prompt: { message, setName: "Untitled" } });
  assert.deepEqual(native.pressed, []);
});

test("No is pressed once and counts only after the prompt is observed closed", () => {
  for (const pressCode of [0, -25204]) {
    const native = nativePrompt({ pressCode });
    assert.deepEqual(native.execute({ answer: "No", message }), { answered: "No", dismissed: true });
    assert.deepEqual(native.pressed, ["No"]);
  }
  const stuck = nativePrompt({ closes: false });
  assert.deepEqual(stuck.execute({ answer: "No", message }), { answered: "No", dismissed: false });
  assert.deepEqual(stuck.pressed, ["No"]);
});

test("another app, another dialog or a changed prompt is never answered", () => {
  assert.throws(() => nativePrompt({ path: "/Applications/Other.app" }).execute({}), /exact running Live/);
  const other = nativePrompt({ text: "Save changes to \"Untitled\" before closing?" });
  assert.deepEqual(other.execute({}), { prompt: null });
  assert.throws(() => other.execute({ answer: "No", message }), /no button was pressed/);
  const changed = nativePrompt();
  assert.throws(() => changed.execute({ answer: "No", message: message.replace("Untitled", "Song") }), /no button was pressed/);
  assert.throws(() => changed.execute({ answer: "Cancel", message }), /no button was pressed/);
  assert.deepEqual([...other.pressed, ...changed.pressed], []);
});

test("the host targets the one running Live app and refuses others before any script runs", async () => {
  const live = `${appPath}/Contents/MacOS/Live`;
  const fixture = (processes, configured) => {
    const scripts = [];
    const host = new MacLiveSetHost({ platform: "darwin", appPath: configured, run: async (command, args) => {
      if (command === "/bin/ps") return { stdout: processes.map((path, index) => `${40 + index} ${path}`).join("\n") };
      scripts.push(JSON.parse(args[3]));return { stdout: JSON.stringify({ prompt: { message, setName: "Untitled" } }) };
    } });
    return { host, scripts };
  };
  const one = fixture([live]);
  assert.deepEqual(await one.host.recoveryPrompt(), { pid: 40, appPath, prompt: { message, setName: "Untitled" } });
  assert.deepEqual(one.scripts, [{ pid: 40, appPath }]);
  for (const [processes, configured] of [[[live, live]], [[]], [[live], "/"]]) {
    const refused = fixture(processes, configured);
    await assert.rejects(refused.host.recoveryPrompt({ answer: "No", message }));
    assert.deepEqual(refused.scripts, []);
  }
});

function serviceFixture() {
  const state = { pid: 42, prompt: { message, setName: "Untitled" } }, answers = [];
  const liveSetHost = { recoveryPrompt: async ({ answer, message: planned } = {}) => {
    if (answer === undefined) return { pid: state.pid, appPath, prompt: state.prompt && { ...state.prompt } };
    answers.push([answer, planned]);state.prompt = null;return { pid: state.pid, appPath, answered: answer, dismissed: true };
  } };
  const service = new ToolService({ liveSetHost, bridge: { request: async () => { throw new Error("bridge unavailable"); } } });
  return { service, state, answers };
}

test("answer_live_recovery_prompt plans and answers without a bridge, with a valid receipt", async () => {
  assert.equal(toolContracts.answer_live_recovery_prompt.annotations.destructiveHint, true);
  assert.throws(() => validateToolArguments("answer_live_recovery_prompt", { answer: "Cancel" }));
  const { service, answers } = serviceFixture(), args = { answer: "No" };
  const plan = validateToolResult("answer_live_recovery_prompt", await service.call("answer_live_recovery_prompt", args), args);
  assert.equal(plan.plan.prompt.setName, "Untitled");assert.deepEqual(answers, []);
  const execute = { ...args, dryRun: false, confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash };
  const result = validateToolResult("answer_live_recovery_prompt", await service.call("answer_live_recovery_prompt", execute), execute);
  assert.equal(result.dismissed, true);assert.equal(result.operationOutcome.status, "applied");
  assert.deepEqual(answers, [["No", message]]);
  await assert.rejects(service.call("answer_live_recovery_prompt", execute));
  assert.equal(answers.length, 1);
});

test("a changed or closed prompt rejects the confirmed answer before any button is pressed", async () => {
  for (const change of ["pid", "message", "closed"]) {
    const { service, state, answers } = serviceFixture(), args = { answer: "No" };
    const plan = await service.call("answer_live_recovery_prompt", args);
    if (change === "pid") state.pid = 43;
    if (change === "message") state.prompt = { message: message.replace("Untitled", "Song"), setName: "Song" };
    if (change === "closed") state.prompt = null;
    await assert.rejects(service.call("answer_live_recovery_prompt", { ...args, dryRun: false,
      confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }));
    assert.deepEqual(answers, [], change);
  }
});
