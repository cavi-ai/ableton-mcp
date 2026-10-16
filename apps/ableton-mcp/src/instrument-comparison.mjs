import { hashPlan } from "./confirmation-store.mjs";

export async function instrumentComparison(bridge, confirmations, name, args) {
  if (name === "get_instrument_comparison") return bridge.request(name, args);
  if (!Number.isInteger(args.expectedStateVersion)) throw new Error("expectedStateVersion is required");
  const preparing = name === "prepare_instrument_comparison";
  const adopting = name === "adopt_instrument_comparison";
  if (preparing && (typeof args.name !== "string" || !args.name.trim() || args.name.length > 128))
    throw new Error("comparison name must contain 1-128 characters");
  if (!preparing && !adopting && !["original", "variation", "restore"].includes(args.choice))
    throw new Error("comparison choice must be original, variation or restore");
  const target = adopting ? { original: args.original, variation: args.variation }
    : preparing ? { trackId: args.trackId, clipId: args.clipId, name: args.name }
    : { comparisonId: args.comparisonId, choice: args.choice, finish: args.finish ?? false };
  if (adopting && [args.original,args.variation].some(part => typeof part?.trackId !== "string" || typeof part.clipId !== "string"))
    throw new Error("adoption requires exact original and variation track/clip references");
  const before = await bridge.request(adopting ? "get_instrument_comparison_adoption_source"
    : preparing ? "get_instrument_comparison_source" : "get_instrument_comparison",
    adopting ? target : preparing ? { trackId: args.trackId, clipId: args.clipId } : { comparisonId: args.comparisonId });
  if (before.stateVersion !== args.expectedStateVersion || (preparing &&
    (before.trackId !== args.trackId || before.clipId !== args.clipId)) ||
    (adopting && ["original","variation"].some(side => before[side]?.trackId !== args[side].trackId || before[side]?.clipId !== args[side].clipId)) ||
    (!preparing && !adopting && before.comparisonId !== args.comparisonId)) throw new Error("instrument comparison state changed; re-read");
  const plan = { method: name, expectedStateVersion: args.expectedStateVersion, ...target, before };
  if (args.dryRun !== false) return { dryRun: true,
    plan: { method: name, expectedStateVersion: args.expectedStateVersion, ...target,
      observedDigest: hashPlan(before),
      ...(adopting ? { restoreMutes: before.restoreMutes,
        parts: Object.fromEntries(["original", "variation"].map(side => [side, {
          name: before[side].trackState?.track.name, clipName: before[side].clip?.name,
          devices: before[side].trackState?.devices.map(device => device.name)
        }])),
        warning: "Creates a new handle for these existing parts without editing Live. Restore uses both current mutes at adoption; earlier pair identity, copy history and mute state are unknown." }
        : preparing ? { source: { trackId: before.trackId, clipId: before.clipId,
        name: before.sourceName, clipName: before.partName, devices: before.deviceNames }, destinationId: before.destinationId,
        warning: "Native track duplication temporarily mutes the source, then restores its mute state. The alternative remains muted, unarmed and input monitoring off. Following track IDs shift; re-read before more edits." }
        : { original: before.original, variation: before.variation, readinessErrors: before.readinessErrors,
          restoreMutes: before.restoreMutes, restorationBasis: before.restorationBasis,
          warning: "Changes only pair mutes; it does not launch clips, stop playback or prove audible output. Finishing preserves both tracks and ends this comparison handle." }) },
    confirmation: confirmations.issue(plan) };
  const planHash = hashPlan(plan);
  if (args.planHash !== planHash) throw new Error("confirmation plan hash mismatch: comparison state changed");
  confirmations.consume(args.confirmationToken, planHash);
  const observed = await bridge.request(name, plan);
  // Do not repeat large source snapshots in the mutation receipt.
  const { before: _, ...requested } = plan;
  return { dryRun: false, requested: { ...requested, observedDigest: hashPlan(before) }, observed };
}
