import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("../src/live-clip-groove-dialog.js", import.meta.url), "utf8");

function fixture() {
  const array = values => ({count: values.length, objectAtIndex: i => values[i]});
  const header = {AXIdentifier: "ClipDetailView.Header.HeaderText", AXValue: "Unique target"};
  const chooser = {AXIdentifier: "ClipDetailView.MainProperties.ClipGrooveView.GrooveChooser", AXValue: "Swing", AXEnabled: true};
  const root = {AXIdentifier: "ClipDetailView", AXChildren: array([header, chooser])};
  const window = {AXSubrole: "AXStandardWindow", AXMain: true, AXDocument: "file:///sets/Idea.als", AXChildren: array([root])};
  const none = {AXRole: "AXMenuItem", AXTitle: "None", AXEnabled: true};
  const menu = {AXRole: "AXMenu", AXIdentifier: "ChooserPopUp", AXChildren: array([none, {AXRole: "AXMenuItem", AXTitle: "✔ Swing"}])};
  const popup = {AXSubrole: "AXUnknown", AXChildren: array([menu])};
  let windows = [window]; const presses = [], keys = [];
  const app = {get AXWindows() {return array(windows);}};
  const native = Object.assign(value => value, {
    AXUIElementCreateApplication: () => app,
    AXUIElementCopyAttributeValue: (element, key, ref) => {if (element[key] === undefined) return -25212; ref[0] = element[key]; return 0;},
    CFEqual: (a, b) => a === b,
    AXUIElementPerformAction: element => {
      presses.push(element === chooser ? "chooser" : element === none ? "None" : "unexpected");
      if (element === chooser) windows = [window, popup];
      if (element === none) {chooser.AXValue = "None"; windows = [window];}
      return 0;
    }
  });
  const events = {applicationProcesses: {whose: () => () => [{bundleIdentifier: () => "com.ableton.live", frontmost: () => true}]},
    keyCode: key => {keys.push(key); windows = [window];}};
  const run = vm.runInNewContext(`${source}\nrun`, {Application: () => events, $: native, Ref: () => [], delay() {},
    ObjC: {import() {}, unwrap: value => value, castRefToObject: value => value}});
  return {header, chooser, menu, window, presses, keys,
    call: (action, extra = {}) => JSON.parse(run([JSON.stringify({pid: 42, filePath: "/sets/Idea.als", clipName: "Unique target", grooveName: "Swing", action, ...extra})]))};
}

test("groove UI chooses only None from its exact prepared menu", () => {
  const f = fixture(), prepared = f.call("prepare");
  assert.deepEqual(prepared.menuTitles, ["None", "✔ Swing"]);
  assert.equal(f.call("commit", prepared).noneSelected, true);
  assert.deepEqual(f.presses, ["chooser", "None"]);
  assert.deepEqual(f.keys, []);
});

test("document, clip and menu changes prevent the None action", () => {
  for (const changed of ["document", "clip", "menu"]) {
    const f = fixture(), prepared = f.call("prepare");
    if (changed === "document") f.window.AXDocument = "file:///sets/Other.als";
    if (changed === "clip") f.header.AXValue = "Other clip";
    if (changed === "menu") prepared.menuTitles = ["None", "Other groove"];
    assert.throws(() => f.call("commit", prepared), /changed|unavailable/);
    assert.deepEqual(f.presses, ["chooser"]);
  }
});

test("cancellation closes only the matching prepared groove menu", () => {
  const f = fixture(), prepared = f.call("prepare");
  assert.equal(f.call("cancel", prepared).cancelled, true);
  assert.deepEqual(f.keys, [53]);
  assert.deepEqual(f.presses, ["chooser"]);
  const other = fixture(); other.call("prepare");
  assert.throws(() => other.call("cancel", {menuTitles: ["None", "Unexpected"]}), /changed/);
  assert.deepEqual(other.keys, []);
});
