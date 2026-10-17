import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {realpath} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {hashPlan} from "./confirmation-store.mjs";
import {inspectGroovePostconditions} from "./groove-workflow.mjs";
import {requestSignal} from "./request-context.mjs";
import {MacLiveSetHost} from "./live-set-host.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./live-clip-groove-dialog.js", import.meta.url));
const withoutVersions = value => Array.isArray(value) ? value.map(withoutVersions) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "stateVersion").map(([key, item]) => [key, withoutVersions(item)])) : value;

export async function removeClipGroove(bridge, confirmations, host, args) {
  if (!Number.isInteger(args.expectedStateVersion)) throw Error("expectedStateVersion is required");
  if (["loop", "timeSignature", "launchQuantization", "launchLegato", "mute", "editorGrid"].some(key => args[key] !== undefined))
    throw Error("groove removal must be the only clip timing change");
  const target = {trackId: args.trackId, clipId: args.clipId};
  const before = await bridge.request("get_clip_groove_removal_context", target);
  if (before.stateVersion !== args.expectedStateVersion || before.clip?.trackId !== args.trackId || before.clip?.clipId !== args.clipId)
    throw Error("groove removal identity or state changed");
  const native = await host.context(before);
  const plan = {method: "remove_clip_groove", ...target, expectedStateVersion: args.expectedStateVersion, before, native,
    warning: "Uses Live's macOS None menu, without baking. Requires a saved Set and a globally unique clip name. Selects and leaves the target in Clip View; prior focus and playhead are not restored. Does not remove the groove from the shared pool."};
  if (args.dryRun !== false) return {dryRun: true, plan, confirmation: confirmations.issue(plan)};
  if (args.planHash !== hashPlan(plan)) throw Error("confirmation plan hash mismatch: groove removal context changed");
  confirmations.consume(args.confirmationToken, args.planHash);
  const signal = requestSignal();
  const prepared = async () => {
    signal?.throwIfAborted();
    const result = await bridge.request("prepare_clip_groove_removal", {...target, expectedStateVersion: args.expectedStateVersion, before});
    if (result.prepared !== true || result.trackId !== args.trackId || result.clipId !== args.clipId || result.stateVersion !== args.expectedStateVersion + 1)
      throw Error("exact native Clip View preparation was not verified");
  };
  const recheck = async () => {
    signal?.throwIfAborted();
    const current = await bridge.request("get_clip_groove_removal_context", target);
    if (hashPlan(withoutVersions(current)) !== hashPlan(withoutVersions(before))) throw Error("groove removal context changed before None selection");
    const selected = await bridge.request("get_selection_context", {});
    if (selected.setFingerprint !== before.setFingerprint || selected.detailClip?.trackId !== args.trackId || selected.detailClip?.clipId !== args.clipId)
      throw Error("displayed clip changed before groove removal");
  };
  let ui;
  try {ui = await host.remove(native, {prepared, recheck, signal});}
  catch (error) {throw Object.assign(Error(`groove removal UI outcome is unverified; inspect the clip before retrying: ${error.message}`), {cause: error});}
  if (ui.noneSelected !== true) throw Error("native None selection is unverified; inspect before retrying");
  const after = await bridge.request("get_clip_groove_context", target);
  const verification = inspectGroovePostconditions("remove", before.clip, after);
  return {dryRun: false, requested: plan, observed: after.timing, removalVerified: true, ui,
    verification, focus: {trackId: args.trackId, clipId: args.clipId, view: "Detail/Clip"}};
}

export class MacClipGrooveHost {
  constructor({platform = process.platform, liveSetHost = new MacLiveSetHost(), run = execute} = {}) {
    this.platform = platform; this.liveSetHost = liveSetHost; this.run = run;
  }
  async context(before) {
    if (this.platform !== "darwin") throw Error("native groove removal UI is macOS only");
    if (typeof before.filePath !== "string" || !isAbsolute(before.filePath) || !/\.als$/iu.test(before.filePath)) throw Error("groove removal requires a saved Set");
    const appPath = await realpath(this.liveSetHost.appPathFor(before)), executable = await realpath(`${appPath}/Contents/MacOS/Live`);
    const processes = await this.liveSetHost.runningProcesses();
    if (processes.length !== 1 || processes[0].path !== executable) throw Error("groove removal requires one exact Live process");
    const selected = before.clip.timing.availableGrooves.filter(g => g.id === before.clip.timing.grooveId);
    if (selected.length !== 1 || !selected[0].name) throw Error("native assigned groove name is ambiguous");
    return {pid: processes[0].pid, appPath, executable, filePath: before.filePath, clipName: before.clip.clipName, grooveName: selected[0].name};
  }
  async remove(context, {prepared, recheck, signal}) {
    if (this.busy) throw Error("another groove removal UI operation is active");
    this.busy = true;
    const dialog = async (action, owned = {}, operationSignal = signal) => JSON.parse((await this.run("/usr/bin/osascript",
      ["-l", "JavaScript", script, JSON.stringify({...context, ...owned, action})], {timeout: 10000, maxBuffer: 65536, signal: operationSignal})).stdout);
    try {
      signal?.throwIfAborted();
      await prepared();
      await this.run("/usr/bin/open", ["-a", context.appPath], {timeout: 5000, signal});
      const owned = await dialog("prepare");
      if (owned.prepared !== true || !Array.isArray(owned.menuTitles)) throw Error("native groove menu preparation is unverified");
      try {await recheck(); signal?.throwIfAborted();}
      catch (error) {
        try {await dialog("cancel", {menuTitles: owned.menuTitles}, AbortSignal.timeout(5000));}
        catch {error.message += "; owned groove menu closure is unverified";}
        throw error;
      }
      return await dialog("commit", {menuTitles: owned.menuTitles});
    } finally {this.busy = false;}
  }
}
