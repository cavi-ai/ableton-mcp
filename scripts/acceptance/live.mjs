import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpAcceptanceClient } from "./mcp-client.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const stable = value => JSON.parse(JSON.stringify(value, (key, item) => key === "stateVersion" ? undefined : item));
const sha256 = value => createHash("sha256").update(value).digest("hex");

export function assertAcceptanceFixture(live, setPath) {
  assert.ok(setPath && /\.als$/i.test(setPath), "--set must name an explicit saved scratch .als Set");
  assert.ok(live.filePath, "Open and save the scratch Set before running acceptance");
  assert.equal(realpathSync(live.filePath), realpathSync(setPath), "Live must contain the explicitly selected scratch Set");
  assert.equal(live.isPlaying, false, "Acceptance requires stopped playback");
}

export async function runLiveAcceptance({ setPath, outDir, progress = value => console.log(JSON.stringify(value)) }) {
  assert.ok(setPath && /\.als$/i.test(setPath), "--set must name an explicit saved scratch .als Set");
  setPath = realpathSync(setPath);
  outDir = resolve(outDir || ".tmp/live-acceptance"); mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const report = { schemaVersion: 1, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    setSha256: sha256(readFileSync(setPath)), scenarios: [], cleanup: false, passed: false };
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(), "",
    "Commit the candidate before running acceptance so evidence identifies the tested source");
  const save = () => writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  const name = `MCP Acceptance ${randomUUID()}`;
  let client, trackId, original;
  const connect = async () => {
    client = new McpAcceptanceClient({ env: { ...process.env, ABLETON_MCP_TOOL_PROFILE: "all", ABLETON_MCP_TOOL_SLICES: undefined, ABLETON_MCP_FIXTURE: "" } });
    await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "live-acceptance", version: "1" } });
    const live = await client.call("get_live_state"); assertAcceptanceFixture(live, setPath);
    report.liveVersion = live.liveVersion || null; report.bridgeVersion = live.bridgeVersion;
  };
  const call = (tool, args) => client.call(tool, args);
  const apply = async (tool, args) => {
    const live = await call("get_live_state"); assertAcceptanceFixture(live, setPath);
    const request = { ...args, expectedStateVersion: live.stateVersion };
    const plan = await call(tool, request); assert.equal(plan.dryRun, true);
    const result = await call(tool, { ...request, dryRun: false,
      confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash });
    assert.equal(result.operationOutcome.status, "applied", `${tool}: ${JSON.stringify(result.operationOutcome)}`);
    return result;
  };
  const snapshot = async () => {
    const tracks = (await call("list_tracks")).tracks;
    return { song: stable(await call("get_song_musical_context")), tracks,
      mixers: await Promise.all(tracks.map(track => call("get_track_mixer", { trackId: track.id }).then(stable))),
      devices: await Promise.all(tracks.map(track => call("list_devices", { trackId: track.id }).then(stable))) };
  };
  const run = async (scenario, fn) => {
    progress({ scenario, status: "running" });
    const row = { scenario, passed: false }; report.scenarios.push(row); save();
    Object.assign(row, await fn(), { passed: true }); save(); progress({ scenario, status: "passed" });
  };
  try {
    await connect(); original = await snapshot();
    await run("guarded-writes", async () => {
      await apply("create_track", { type: "midi", name });
      const created = (await call("list_tracks")).tracks.filter(track => track.name === name);
      assert.equal(created.length, 1); trackId = created[0].id;
      const clipId = `${trackId}:clip-0`;
      await apply("create_midi_clip", { trackId, clipId, name, lengthBeats: 4,
        notes: [{ pitch: 60, start: 0, duration: 1, velocity: 80, mute: false }] });
      const browser = await call("search_browser_roots", { roots: ["audio_effects"], query: "Utility", maxDepth: 6, limit: 20, maxVisited: 10000 });
      const utility = browser.results.find(item => item.name === "Utility" && item.loadable);
      assert.ok(utility, "Utility must be available in Live's Audio Effects browser");
      await apply("load_browser_item", { trackId, root: utility.root, path: utility.path });
      const device = (await call("list_devices", { trackId })).devices.find(item => item.className === "StereoGain" || item.name === "Utility");
      assert.ok(device, "Utility must load on the acceptance track");
      return { trackId, clipId, deviceId: device.id };
    });
    report.passed = true;
  } catch (error) { report.error = error.message; throw error; }
  finally {
    try {
      if (trackId || original) {
        if (client.closed) await connect();
        const owned = (await call("list_tracks")).tracks.filter(track => track.name === name);
        assert.ok(owned.length <= 1, "acceptance ownership is ambiguous");
        if (owned.length) await apply("delete_session_object", { targetType: "track", targetId: owned[0].id, allowContent: true });
        if (original) assert.deepEqual(await snapshot(), original, "unrelated Set state changed");
        assert.equal(sha256(readFileSync(setPath)), report.setSha256, "acceptance must not save over the fixture file");
        assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), report.commit, "source commit changed during acceptance");
        execFileSync("git", ["diff", "--exit-code", "HEAD"], { cwd: root, stdio: "pipe" });
        report.cleanup = true;
      }
    } catch (error) { report.cleanupError = error.message; report.passed = false; throw error; }
    finally { await client?.close(); save(); }
  }
  assert.equal(report.cleanup, true); return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  runLiveAcceptance({ setPath: option("--set"), outDir: option("--out") })
    .then(report => console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, cleanup: report.cleanup })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
