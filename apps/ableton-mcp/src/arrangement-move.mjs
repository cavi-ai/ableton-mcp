import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function moveArrangementClip(bridge, confirmations, args) {
  if (!Number.isSafeInteger(args.expectedStateVersion) || !Number.isFinite(args.startBeats) || args.startBeats < 0 || args.startBeats > Number.MAX_SAFE_INTEGER) {
    throw Error('fresh expectedStateVersion and finite nonnegative startBeats required');
  }
  const ids = {trackId: args.trackId, clipId: args.clipId, startBeats: args.startBeats};
  const before = await bridge.request('get_arrangement_move_source', ids);
  assertExpectedState(args, before);
  if (!before.identityToken || !before.source || before.clipId !== args.clipId || before.startBeats !== args.startBeats) {
    throw Error('updated native Arrangement move context required');
  }
  const plan = {method: 'move_arrangement_clip', ...ids, expectedStateVersion: args.expectedStateVersion, before};
  if (args.dryRun !== false) return {dryRun: true, plan, confirmation: confirmations.issue(plan)};
  if (args.planHash !== hashPlan(plan)) throw Error('Arrangement move confirmation context changed');
  confirmations.consume(args.confirmationToken, args.planHash);
  return {dryRun: false, requested: plan, observed: await bridge.request(plan.method, plan)};
}
