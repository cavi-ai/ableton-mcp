import { hashPlan } from "./confirmation-store.mjs";

export async function duplicateMidiClipVariations(bridge, confirmations, args) {
  if (!Number.isInteger(args.expectedStateVersion)) throw new Error("expectedStateVersion is required");
  if (!Array.isArray(args.variants) || args.variants.length < 1 || args.variants.length > 4)
    throw new Error("supply one to four named variations");
  const ids = new Set();
  for (const variant of args.variants) {
    if (typeof variant.name !== "string" || !variant.name.trim() || variant.name.length > 128)
      throw new Error("variation name must contain 1–128 characters");
    if (ids.has(variant.clipId)) throw new Error("variation destinations must be unique");
    ids.add(variant.clipId);
  }
  const before = await bridge.request("get_midi_clip_variation_context", {
    trackId: args.trackId, sourceClipId: args.sourceClipId
  });
  if (before.stateVersion !== args.expectedStateVersion || before.trackId !== args.trackId ||
      before.sourceClipId !== args.sourceClipId) throw new Error("MIDI variation source state changed; re-read");
  for (const variant of args.variants) {
    const slot = before.slots.find(slot => slot.id === variant.clipId);
    if (!slot || slot.hasClip || variant.clipId === args.sourceClipId)
      throw new Error("variation destination must be an existing empty slot on the source track");
  }
  const plan = { method: "duplicate_midi_clip_variations", expectedStateVersion: args.expectedStateVersion,
    trackId: args.trackId, sourceClipId: args.sourceClipId, variants: args.variants, before };
  if (args.dryRun !== false) return { dryRun: true, plan, confirmation: confirmations.issue(plan) };
  const planHash = hashPlan(plan);
  if (args.planHash !== planHash) throw new Error("confirmation plan hash mismatch: source or destinations changed");
  confirmations.consume(args.confirmationToken, planHash);
  const observed = await bridge.request("duplicate_midi_clip_variations", plan);
  return { dryRun: false, requested: plan, observed };
}
