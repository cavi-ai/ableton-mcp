import {hashPlan} from './confirmation-store.mjs';

export async function returnTracksToArrangement(bridge, confirmations, args) {
  const ids = args.trackIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^track-(0|[1-9][0-9]*)$/.test(id)))
    throw new Error('return requires 1-64 unique ordinary track IDs');
  if (!Number.isInteger(args.expectedStateVersion)) throw new Error('expectedStateVersion is required');
  const before = await bridge.request('get_arrangement_return_source', {trackIds: ids});
  if (before.stateVersion !== args.expectedStateVersion || !before.identityToken ||
      JSON.stringify(before.trackIds) !== JSON.stringify(ids)) throw new Error('Arrangement return identity or state changed');
  const plan = {method: 'return_tracks_to_arrangement', trackIds: ids, expectedStateVersion: args.expectedStateVersion, before};
  if (args.dryRun !== false) return {dryRun: true, plan, confirmation: confirmations.issue(plan), warning:
    'Immediately returns only the named ordinary tracks from Session override. This can stop their Session clips and reveal Arrangement material or silence. Global playback and loop settings are retained; no seek is requested. Other tracks retain their overrides. This is not beat scheduling or audible verification. Earlier Session phase is not restored. Inspect partial results before retrying; never blindly replay an uncertain return.'};
  if (args.planHash !== hashPlan(plan)) throw new Error('confirmation plan hash mismatch: Arrangement return context changed');
  confirmations.consume(args.confirmationToken, args.planHash);
  return {dryRun: false, requested: plan, observed: await bridge.request(plan.method, plan)};
}
