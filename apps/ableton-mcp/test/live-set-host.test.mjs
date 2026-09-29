import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
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
