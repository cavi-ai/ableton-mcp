import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/live-set-save-dialog.js", import.meta.url), "utf8");

function dialog({ windowId = 123, purpose = "Save Live Set As:", frontmost = true, bundle = "com.ableton.live",
  filename = "Original.als", directory = "/tmp/work", folderUnavailable = false, retainedClosedWindow = false,
  unexpectedSheet = false, saveEnabled = true } = {}) {
  const keys = [], saves = [];
  let visible = true;
  const element = (role, id, value, children = []) => {
    const attributes = { AXIdentifier: id, AXMain: true, AXModal: true, AXFocused: false };
    const result = { role: () => role, uiElements: () => children, position: () => [10,20], size: () => [800,400],
      enabled: () => id !== "OKButton" || saveEnabled, sheets: () => [], actions: { byName: () => ({ perform: () => {
        saves.push(id);if(id === "CancelButton")visible = false;
      } }) },
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
    element("AXTextField", "saveAsNameTextField", filename), element("AXPopUpButton", "where popup", "work"),
    element("AXButton", "OKButton", ""), element("AXButton", "CancelButton", "")]);
  let navigating = false;
  panel.sheets = () => unexpectedSheet ? [element("AXSheet", "Replace", "")] : navigating ? [sheet] : [];
  const process = { bundleIdentifier: () => bundle, frontmost: () => frontmost, windows: () => visible ? [panel] : [] };
  const events = { applicationProcesses: { whose: () => () => [process] },
    keystroke: key => { keys.push(key);navigating = true; }, keyCode: key => { keys.push(key);navigating = false; } };
  const array = items => ({ count: items.length, objectAtIndex: index => items[index] });
  const folder = { AXURL: { isFileURL: true, hasDirectoryPath: true, filePathURL: { get path() { return directory; } } } };
  const browser = { AXIdentifier: "ColumnView", AXRole: "AXBrowser", AXColumns: array([
    { AXChildren: array([{ AXRole: "AXList", AXSelectedChildren: array([{ AXChildren: array([folder]) }]) }]) }, {}]) };
  const nativePanel = { AXIdentifier: "save-panel", AXRole: "AXWindow", AXChildren: array([browser]) };
  const nativeApp = { AXWindows: array([nativePanel]) };
  const native = Object.assign(value => value, {
    AXUIElementCreateApplication: () => nativeApp,
    AXUIElementCopyAttributeValue: (element, key, ref) => {
      if (folderUnavailable || element[key] === undefined) return -25212;
      ref[0] = element[key];return 0;
    },
    CGWindowListCopyWindowInfo: option => [
      ...(visible ? [{ kCGWindowOwnerPID: 42, kCGWindowNumber: windowId, kCGWindowIsOnscreen: true,
        kCGWindowBounds: { X: 10, Y: 20, Width: 800, Height: 400 } }] : []),
      ...(retainedClosedWindow && option === 0 ? [{ kCGWindowOwnerPID: 42, kCGWindowNumber: 122,
        kCGWindowBounds: { X: 10, Y: 20, Width: 800, Height: 400 } }] : [])] });
  const run = vm.runInNewContext(`${source}\nrun`, { Application: () => events, Ref: () => [],
    ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value },
    $: native, delay() {} });
  return { execute: action => run([JSON.stringify({ pid: 42, action, windowId: 123, purpose: "Save Live Set As:",
    panelState: {name:"Original.als",folder:"/tmp/work"},parent: "/tmp/work", name: "Working.als" })]), keys, saves };
}

test("Save As refuses a replacement window, other Save purpose, wrong app or lost focus before input", () => {
  for (const state of [{ windowId: 124 }, { purpose: "Save preset:" }, { bundle: "other.app" }, { frontmost: false }]) {
    const native = dialog(state);
    let failure;try{failure=JSON.parse(native.execute("commit")).error;}catch(error){failure=error.message;}
    assert.ok(failure);assert.deepEqual(native.keys, []);assert.ok(!native.saves.includes("OKButton"));
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

test("Save As cancels only the unchanged prepared panel without sending foreground keys",()=>{
  const native=dialog({frontmost:false});
  const result=JSON.parse(native.execute("cancel"));
  assert.equal(result.cancelled,true);assert.equal(result.savePressed,false);
  assert.deepEqual(native.keys,[]);assert.deepEqual(native.saves,["CancelButton"]);
  for(const state of [{windowId:124},{purpose:"Save preset:"},{bundle:"other.app"},
    {filename:"User edit.als"},{unexpectedSheet:true}]){
    const other=dialog(state);assert.throws(()=>other.execute("cancel"));
    assert.deepEqual(other.keys,[]);assert.deepEqual(other.saves,[]);
  }
});

test("Save As reports pre-Save failure and verified cleanup without pressing Save",()=>{
  const native=dialog({saveEnabled:false}),result=JSON.parse(native.execute("commit"));
  assert.equal(result.savePressed,false);assert.match(result.error,/Save is disabled/);
  assert.equal(result.recovery.status,"cancelled");assert.deepEqual(native.saves,["CancelButton"]);
});

test("Save As preserves a different directory with the same label and an unavailable directory",()=>{
  for(const state of [{directory:"/other/work"},{folderUnavailable:true}]){
    const native=dialog(state);
    assert.throws(()=>native.execute("cancel"));
    assert.deepEqual(native.keys,[]);assert.deepEqual(native.saves,[]);
  }
});

test("Save As verifies closure when AppKit retains an offscreen window",()=>{
  const native=dialog({retainedClosedWindow:true});
  assert.equal(JSON.parse(native.execute("cancel")).cancelled,true);
  assert.deepEqual(native.saves,["CancelButton"]);
});
