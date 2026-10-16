import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/live-set-save-dialog.js", import.meta.url), "utf8");

function dialog({ windowId = 123, purpose = "Save Live Set As:", frontmost = true, bundle = "com.ableton.live" } = {}) {
  const keys = [], saves = [];
  const element = (role, id, value, children = []) => {
    const attributes = { AXIdentifier: id, AXMain: true, AXModal: true, AXFocused: false };
    const result = { role: () => role, uiElements: () => children, position: () => [10,20], size: () => [800,400],
      enabled: () => true, sheets: () => [], actions: { byName: () => ({ perform: () => saves.push(id) }) },
      attributes: { byName: key => {
        const attribute = {};
        Object.defineProperty(attribute, "value", { get: () => () => attributes[key], set: next => { attributes[key] = next; } });
        return attribute;
      } } };
    Object.defineProperty(result, "value", { get: () => () => value, set: next => { value = next; } });
    return result;
  };
  const path = element("AXTextField", "PathTextField", "");
  const sheet = element("AXSheet", "GoToWindow", "", [path]);
  const panel = element("AXWindow", "save-panel", "", [element("AXStaticText", "_messageTextField", purpose),
    element("AXTextField", "saveAsNameTextField", "Original.als"), element("AXPopUpButton", "where popup", "work"),
    element("AXButton", "OKButton", "")]);
  let navigating = false;
  panel.sheets = () => navigating ? [sheet] : [];
  const process = { bundleIdentifier: () => bundle, frontmost: () => frontmost, windows: () => [panel] };
  const events = { applicationProcesses: { whose: () => () => [process] },
    keystroke: key => { keys.push(key);navigating = true; }, keyCode: key => { keys.push(key);navigating = false; } };
  const run = vm.runInNewContext(`${source}\nrun`, { Application: () => events,
    ObjC: { import() {}, deepUnwrap: value => value, castRefToObject: value => value },
    $: { CGWindowListCopyWindowInfo: () => [{ kCGWindowOwnerPID: 42, kCGWindowNumber: windowId,
      kCGWindowBounds: { X: 10, Y: 20, Width: 800, Height: 400 } }] }, delay() {} });
  return { execute: action => run([JSON.stringify({ pid: 42, action, windowId: 123, purpose: "Save Live Set As:",
    parent: "/tmp/work", name: "Working.als" })]), keys, saves };
}

test("Save As refuses a replacement window, other Save purpose, wrong app or lost focus before input", () => {
  for (const state of [{ windowId: 124 }, { purpose: "Save preset:" }, { bundle: "other.app" }, { frontmost: false }]) {
    const native = dialog(state);
    assert.throws(() => native.execute("commit"));
    assert.deepEqual(native.keys, []);assert.deepEqual(native.saves, []);
  }
});

test("Save As refuses a preexisting modal and never accepts Replace", () => {
  const native = dialog();
  assert.throws(() => native.execute("prepare"), /existing Live dialog/);
  assert.deepEqual(native.keys, []);assert.deepEqual(native.saves, []);
});

test("Save As focuses the exact folder field and presses only the bound Save button", () => {
  const native = dialog();
  assert.equal(JSON.parse(native.execute("commit")).savePressed, true);
  assert.deepEqual(native.keys, ["g",36]);assert.deepEqual(native.saves, ["OKButton"]);
});
