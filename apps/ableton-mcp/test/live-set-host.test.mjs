import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacLiveSetHost } from "../src/live-set-host.mjs";

test("open resolves an existing Live Set and targets the bridge's exact app bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-live-set-"));
  const path = join(directory, "Song.als");
  const calls = [];
  try {
    await writeFile(path, "fixture");
    const host = new MacLiveSetHost({ platform: "darwin", run: async (...args) => { calls.push(args); } });
    const appPath = host.appPathFor({ scriptDirectory: "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/MIDI Remote Scripts/CaviMcpBridge" });
    assert.equal(appPath, "/Applications/Ableton Live 12 Suite.app");
    const canonical = await realpath(path);
    assert.equal(await host.existingSet(path), canonical);
    await host.open(appPath, canonical);
    assert.deepEqual(calls, [["/usr/bin/open", ["-a", appPath, canonical]]]);
    await assert.rejects(() => host.existingSet(join(directory, "Missing.als")), /not available/);
    await assert.rejects(() => host.existingSet(join(directory, "Wrong.wav")), /\.als/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("save targets only foreground Ableton and rejects unsupported hosts", async () => {
  const calls = [];
  const host = new MacLiveSetHost({ platform: "darwin", run: async (...args) => { calls.push(args); } });
  await host.save("/Applications/Ableton Live 12 Suite.app");
  assert.equal(calls[0][0], "/usr/bin/open");
  assert.deepEqual(calls[0][1], ["-a", "/Applications/Ableton Live 12 Suite.app"]);
  assert.equal(calls[1][0], "/usr/bin/osascript");
  assert.match(calls[1][1][1], /com\.ableton\.live/);
  assert.match(calls[1][1][1], /keystroke "s" using command down/);
  await assert.rejects(() => new MacLiveSetHost({ platform: "win32" }).save("C:\\Live.exe"), /macOS only/);
});

test("launch context verifies the configured app and observes Live processes without starting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-live-app-"));
  try {
    const appPath = join(directory, "Ableton Live.app"), executable = join(appPath, "Contents/MacOS/Live");
    await mkdir(join(appPath, "Contents/MacOS"), { recursive: true });
    await writeFile(join(appPath, "Contents/Info.plist"), "metadata");
    await writeFile(executable, "binary", { mode: 0o755 });
    let bundle = "com.ableton.live", processes = ` 42 ${executable}\n 43 /Applications/Another Live.app/Contents/MacOS/Live\n 44 /usr/bin/node\n`;
    const calls = [];
    const host = new MacLiveSetHost({ platform: "darwin", appPath, run: async (command, args) => {
      calls.push([command, args]);
      return { stdout: command === "/bin/ps" ? processes
        : JSON.stringify({ CFBundleIdentifier: bundle, CFBundleExecutable: "Live", CFBundleShortVersionString: "12.4.6" }) };
    } });
    const context = await host.launchContext();
    assert.equal(context.app.path, await realpath(appPath));
    assert.equal(context.app.executable, await realpath(executable));
    assert.equal(context.app.version, "12.4.6");
    assert.deepEqual(context.running.map(p => p.pid), [42, 43]);
    assert.equal(typeof context.app.binary.mtimeNs, "string");
    assert.ok(!calls.some(([command]) => command === "/usr/bin/open"));
    processes = " 44 /usr/bin/node\n";
    assert.deepEqual((await host.launchContext()).running, []);
    bundle = "org.example.other";
    await assert.rejects(host.launchContext(), /Ableton Live/);
    await assert.rejects(new MacLiveSetHost({ platform: "darwin" }).launchContext(), /ABLETON_MCP_LIVE_APP_PATH/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cold opening passes the configured bridge socket through Launch Services", async () => {
  const calls = [];
  const host = new MacLiveSetHost({ platform: "darwin", bridgeSocketPath: "/tmp/custom bridge.sock",
    run: async (...args) => { calls.push(args); } });
  await host.open("/Applications/Live.app", "/tmp/Song.als", { launch: true });
  assert.deepEqual(calls[0], ["/usr/bin/open", ["-n", "-a", "/Applications/Live.app", "--env",
    "ABLETON_MCP_BRIDGE_SOCKET=/tmp/custom bridge.sock", "/tmp/Song.als"]]);
});


test("Save As projects the native path and refuses existing files or project folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-save-as-"));
  const host = new MacLiveSetHost({ platform: "darwin" });
  try {
    const parent = await realpath(directory);
    const outside = await host.saveAsDestination(join(directory, "Working.als"));
    assert.equal(outside.path, join(parent, "Working Project/Working.als"));
    assert.equal(outside.createsProject, true);
    await mkdir(join(directory, "Working Project"));
    await assert.rejects(host.saveAsDestination(join(directory, "Working.als")), /exists/);
    await mkdir(join(directory, "Ableton Project Info"));
    const inside = await host.saveAsDestination(join(directory, "Alternative.als"));
    assert.equal(inside.path, join(parent, "Alternative.als"));
    assert.equal(inside.createsProject, false);
    await symlink(join(directory, "Missing.als"), inside.path);
    await assert.rejects(host.saveAsDestination(inside.path), /exists/);
    await assert.rejects(host.saveAsDestination(join(directory, ".Hidden.als")), /filename/);
    await assert.rejects(host.saveAsDestination(join(directory, "Bad:name.als")), /filename/);
    await assert.rejects(host.saveAsDestination(join(directory, "Missing/Song.als")), /directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function saveAppFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "cavi-save-app-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, "Live.app");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(join(app, "Contents/MacOS/Live"), "binary");
  return realpath(app);
}

test("save observation binds one configured process and canonical document URL without activating or typing", async t => {
  const app=await saveAppFixture(t),path=join(app,"../Song with #.als"),calls=[];
  await writeFile(path,"Set");
  const canonical=await realpath(path),{pathToFileURL}=await import("node:url");
  let observed={documentURL:pathToFileURL(canonical).href,saveEnabled:false,saveAsEnabled:true};
  const host=new MacLiveSetHost({platform:"darwin",run:async(command,args)=>{calls.push([command,args]);return {stdout:JSON.stringify(observed)};}});
  host.runningProcesses=async()=>[{pid:42,path:app+"/Contents/MacOS/Live"}];
  assert.equal((await host.observeSaveState(app)).status,"clean");
  assert.equal((await host.observeSaveState(app)).path,canonical);
  observed.saveEnabled=true;assert.equal((await host.observeSaveState(app)).status,"dirty");
  observed.saveEnabled=null;assert.equal((await host.observeSaveState(app)).status,"unavailable");
  observed={...observed,saveEnabled:false,documentURL:"https://example.com/Song.als"};
  assert.equal((await host.observeSaveState(app)).status,"unavailable");
  host.runningProcesses=async()=>[{pid:42,path:"/Other.app/Contents/MacOS/Live"}];
  const count=calls.length;assert.equal((await host.observeSaveState(app)).status,"unavailable");assert.equal(calls.length,count);
  assert.ok(calls.every(([command])=>command==="/usr/bin/osascript"));
});

test("Save As guards the exact process and binds the prepared window before pressing Save", async t => {
  const app = await saveAppFixture(t), calls = [];
  const host = new MacLiveSetHost({ platform: "darwin", run: async (command, args) => {
    calls.push([command, args]);
    return { stdout: JSON.stringify({ prepared: true, windowId: 123, purpose: "Save Live Set As:" }) };
  } });
  host.runningProcesses = async () => [{ pid: 42, path: app + "/Contents/MacOS/Live" }];
  const destination = { name: "It's a $song.als", parent: { path: "/tmp" }, path: "/tmp/It's a $song.als" };
  await host.saveAs(app, destination, { beforeSave: async () => { calls.push(["revalidate"]); } });
  const scriptCalls = calls.filter(([command]) => command === "/usr/bin/osascript");
  assert.deepEqual(scriptCalls.map(([,args]) => JSON.parse(args.at(-1)).action), ["prepare", "commit"]);
  assert.equal(JSON.parse(scriptCalls[0][1].at(-1)).name, destination.name);
  assert.equal(JSON.parse(scriptCalls[1][1].at(-1)).windowId, 123);
  assert.equal(JSON.parse(scriptCalls[1][1].at(-1)).purpose, "Save Live Set As:");
  assert.ok(calls.findIndex(([command]) => command === "revalidate") > calls.indexOf(scriptCalls[0]));
  calls.length = 0;
  await assert.rejects(host.saveAs(app, destination, { beforeSave: async () => { throw Error("Set changed"); } }), /Set changed/);
  assert.equal(calls.filter(([command]) => command === "/usr/bin/osascript").length, 1);
  host.runningProcesses = async () => [{ pid: 43, path: "/Other.app/Contents/MacOS/Live" }];
  await assert.rejects(host.saveAs(app, destination), /exactly one/);
});

test("Save As resolves a configured app symlink before comparison and dispatch", async t => {
  const app = await saveAppFixture(t), alias = join(app, "../Alias.app"), calls = [];
  await symlink(app, alias);
  const host = new MacLiveSetHost({ platform: "darwin", run: async (command,args) => {
    calls.push([command,args]);return { stdout: JSON.stringify({ prepared: true, windowId: 123, purpose: "Save Live Set As:" }) };
  } });
  host.runningProcesses = async () => [{ pid: 42, path: app + "/Contents/MacOS/Live" }];
  await host.saveAs(alias, { name: "Working.als", parent: { path: "/tmp" } }, { beforeSave: async () => {} });
  assert.deepEqual(calls[0], ["/usr/bin/open", ["-a", app]]);
});

test("Save As preserves the native refusal reason instead of a truncated command line", async t => {
  const app = await saveAppFixture(t);
  const host = new MacLiveSetHost({ platform: "darwin", run: async command => {
    if (command === "/usr/bin/osascript") throw Object.assign(Error("long command"), { stderr: "execution error: existing Live dialog" });
  } });
  host.runningProcesses = async () => [{ pid: 42, path: app + "/Contents/MacOS/Live" }];
  await assert.rejects(host.saveAs(app, { parent: { path: "/tmp" }, name: "New.als" }, { beforeSave: async () => {} }), /existing Live dialog/);
});
