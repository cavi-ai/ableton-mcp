import { hashPlan } from "./confirmation-store.mjs";
import { capturedFileEvidence } from "./capture-file-evidence.mjs";

export async function liveAudioCapture(bridge, confirmations, name, args) {
  if (name === "get_live_audio_capture") {
    const result = await bridge.request(name, args);
    if (!result.captures) return capturedFileEvidence(result);
    const captures = [];
    for (const capture of result.captures) captures.push(await capturedFileEvidence(capture));
    return { ...result, captures };
  }
  if (!Number.isInteger(args.expectedStateVersion)) throw new Error("expectedStateVersion is required");
  const starting = name === "capture_live_audio";
  if (starting && (!Number.isFinite(args.beats) || args.beats < 1 || args.beats > 16))
    throw new Error("capture beats must be between 1 and 16");
  if (starting && (typeof args.name !== "string" || !args.name.trim() || args.name.length > 128))
    throw new Error("capture name must contain 1-128 characters");
  if (!starting && args.cancel !== undefined && typeof args.cancel !== "boolean") throw new Error("cancel must be boolean");
  const before = await bridge.request(starting ? "get_audio_capture_source" : "get_live_audio_capture",
    starting ? {} : { captureId: args.captureId });
  if (before.stateVersion !== args.expectedStateVersion || (!starting && before.captureId !== args.captureId))
    throw new Error("Live audio capture state changed; re-read");
  const plan = { method: name, expectedStateVersion: args.expectedStateVersion,
    ...(starting ? { beats: args.beats, name: args.name } : { captureId: args.captureId, cancel: args.cancel ?? false }), before };
  if (args.dryRun !== false) return { dryRun: true, plan, confirmation: confirmations.issue(plan),
    warning: starting
      ? "Records Live's current Resampling signal into a new muted, monitor-off audio track. Source playback continues. Only the capture is stopped and disarmed automatically. A lost client does not cancel the recording; list captures before retrying."
      : "Ends the runtime handle and keeps the recording and track. Cancel stops an active capture early; partial audio is not verified as a completed capture." };
  const planHash = hashPlan(plan);
  if (args.planHash !== planHash) throw new Error("confirmation plan hash mismatch: capture state changed");
  confirmations.consume(args.confirmationToken, planHash);
  return { dryRun: false, requested: plan, observed: await capturedFileEvidence(await bridge.request(name, plan)) };
}
