import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
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
