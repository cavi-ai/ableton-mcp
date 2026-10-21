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

export async function runLiveAcceptance({ setPath, model, discovery = "both", outDir, progress = value => console.log(JSON.stringify(value)) }) {
  assert.ok(setPath && /\.als$/i.test(setPath), "--set must name an explicit saved scratch .als Set");
  assert.ok(model, "--model must name an installed local Ollama model");
  assert.ok(["eager", "deferred", "both"].includes(discovery), "--discovery must be eager, deferred, or both");
  setPath = realpathSync(setPath);
  outDir = resolve(outDir || ".tmp/live-acceptance"); mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const report = { schemaVersion: 1, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    setSha256: sha256(readFileSync(setPath)), model, scenarios: [], cleanup: false, passed: false };
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(), "",
    "Commit the candidate before running acceptance so evidence identifies the tested source");
  const save = () => writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  const modes = discovery === "both" ? ["eager", "deferred"] : [discovery];
  const name = `MCP Acceptance ${randomUUID()}`;
  let client, trackId, original;
  const connect = async mode => {
    client = new McpAcceptanceClient({ env: { ...process.env, ABLETON_MCP_TOOL_PROFILE: "all", ABLETON_MCP_FIXTURE: "",
      ABLETON_MCP_PRODUCER_DIR: resolve(outDir, "artifacts"),
      ABLETON_MCP_PRODUCER_CONFIG: JSON.stringify({ functional: { type: "ollama", model, toolDiscovery: mode } }) } });
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
  const criteria = (tool, args, path, expected) => [{ tool, args, path, expected }];
  const runTask = async (goal, scope, postconditions, projectId) => {
    const task = await call("run_production_task", { projectId, intent: "change", goal, scope, postconditions });
    assert.equal(task.status, "proposed", `incomplete task: ${JSON.stringify(task)}`);
    assert.ok(task.operationCount > 0);
    let stateVersion = task.stateVersion, previousReceiptId;
    for (let operationIndex = 0; operationIndex < task.operationCount; operationIndex++) {
      const args = { projectId, taskId: task.taskId, operationIndex, expectedStateVersion: stateVersion,
        ...(previousReceiptId ? { previousReceiptId } : {}) };
      const plan = await call("apply_production_operation", args); assert.equal(plan.status, "planned");
      const receipt = await call("apply_production_operation", { ...args, dryRun: false,
        confirmationToken: plan.confirmationToken, planHash: plan.planHash });
      assert.equal(receipt.status, "applied", JSON.stringify(receipt));
      stateVersion = receipt.stateVersion; previousReceiptId = receipt.receiptId;
    }
    return { taskId: task.taskId, receiptId: previousReceiptId, operationCount: task.operationCount };
  };
  try {
    await connect(modes[0]); original = await snapshot();
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
    const deviceId = device.id;
    for (const [index, mode] of modes.entries()) {
      if (index) { await client.close(); await connect(mode); }
      const projectId = `acceptance-${mode}-${randomUUID()}`;
      const run = async (scenario, fn) => {
        progress({ mode, scenario, status: "running" });
        const row = { mode, scenario, passed: false }; report.scenarios.push(row); save();
        Object.assign(row, await fn(), { passed: true }); save(); progress({ mode, scenario, status: "passed" });
      };
      await run("mixer", async () => {
        const before = await call("get_track_mixer", { trackId }), target = index ? -9 : -12;
        const result = await runTask(`Inspect ${trackId} and set its volume to exactly ${target} dB. Preserve all other controls.`,
          { trackId }, criteria("get_track_mixer", { trackId }, ["volume", "decibels"], target), projectId);
        const after = await call("get_track_mixer", { trackId });
        assert.equal(after.volume.decibels, target);
        assert.deepEqual(stable({ ...after, volume: null }), stable({ ...before, volume: null }));
        return result;
      });
      await run("midi", async () => {
        const before = await call("get_midi_clip_notes_extended", { trackId, clipId }), target = index ? 100 : 90;
        assert.equal(before.notes.length, 1);
        const result = await runTask(`Inspect MIDI clip ${clipId} and set its note's velocity to ${target}. Preserve note identity, pitch, start, duration and every other property.`,
          { trackId, clipId }, criteria("get_midi_clip_notes_extended", { trackId, clipId }, ["notes", 0, "velocity"], target), projectId);
        const after = await call("get_midi_clip_notes_extended", { trackId, clipId });
        assert.deepEqual(after.notes, before.notes.map(note => ({ ...note, velocity: target })));
        return result;
      });
      await run("device", async () => {
        const before = await call("list_device_parameters", { trackId, deviceId });
        const parameterIndex = before.parameters.findIndex(parameter => parameter.name === "Device On");
        assert.ok(parameterIndex >= 0); const parameter = before.parameters[parameterIndex], target = parameter.value === 0 ? 1 : 0;
        const result = await runTask(`Inspect device ${deviceId}. Set the exposed Device On parameter ${parameter.id} to ${target}, preserving every other parameter.`,
          { trackId, deviceId }, criteria("list_device_parameters", { trackId, deviceId }, ["parameters", parameterIndex, "value"], target), projectId);
        const after = await call("list_device_parameters", { trackId, deviceId });
        assert.equal(after.parameters[parameterIndex].value, target);
        const values = parameters => parameters.filter((_, i) => i !== parameterIndex).map(({ id, value }) => ({ id, value }));
        assert.deepEqual(values(after.parameters), values(before.parameters));
        return result;
      });
      await run("reconnect-resume", async () => {
        const target = index ? -8 : -10;
        let session = await call("start_production_session", { projectId, goal: `Set ${trackId} volume to exactly ${target} dB, preserving other controls.`,
          roles: "functional", completion: "postconditions", scope: { trackId },
          postconditions: criteria("get_track_mixer", { trackId }, ["volume", "decibels"], target) });
        const advance = args => call("advance_production_session", { projectId, sessionId: session.sessionId, expectedRevision: session.revision, ...args });
        session = await advance({ action: "propose" }); assert.equal(session.phase, "apply");
        const taskId = session.taskId;
        await client.close(); await connect(mode);
        session = await call("get_production_session", { projectId, sessionId: session.sessionId });
        session = await advance({ action: "resume" }); assert.equal(session.taskId, taskId); assert.equal(session.phase, "apply");
        while (session.phase === "apply") {
          const live = await call("get_live_state");
          const plan = await advance({ action: "apply", expectedStateVersion: live.stateVersion });
          assert.equal(plan.operation.status, "planned");
          session = await advance({ action: "apply", expectedStateVersion: live.stateVersion, dryRun: false,
            confirmationToken: plan.operation.confirmationToken, planHash: plan.operation.planHash });
          assert.equal(session.operation.status, "applied");
        }
        assert.equal(session.phase, "evaluate"); session = await advance({ action: "evaluate", decision: "accept" });
        assert.equal(session.status, "postconditions_met"); assert.equal(session.audibleQualityVerified, false);
        return { taskId, sessionId: session.sessionId, sessionRef: session.sessionRef };
      });
    }
    report.passed = true;
  } catch (error) { report.error = error.message; throw error; }
  finally {
    try {
      if (trackId || original) {
        if (client.closed) await connect(modes.at(-1));
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
  runLiveAcceptance({ setPath: option("--set"), model: option("--model"), discovery: option("--discovery") || "both", outDir: option("--out") })
    .then(report => console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, cleanup: report.cleanup })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
