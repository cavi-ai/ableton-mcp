import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function removeClip(bridge, confirmations, method, args) {
  if (!Number.isSafeInteger(args.expectedStateVersion)) throw Error('fresh expectedStateVersion required');
  const location = method === 'delete_arrangement_clip' ? 'arrangement' : 'session';
  const clipId = method === 'delete_session_object' ? args.targetId : args.clipId;
  const ids = {trackId: args.trackId, clipId, location};
  const before = await bridge.request('get_clip_removal_source', ids);
  assertExpectedState(args, before);
  if (!before.identityToken || !before.source || before.clipId !== clipId || before.location !== location ||
      before.scope?.wholeClip !== true || before.scope?.includesClipEnvelopesAndNoteExpression !== true || before.scope?.restorableSnapshot !== false) {
    throw Error('updated native whole-clip removal context required');
  }
  const plan = {method, ...ids, expectedStateVersion: args.expectedStateVersion, before,
    ...(method === 'delete_session_object' ? {target: {targetType: 'clip', trackId: args.trackId, targetId: clipId, name: before.source.name}} : {})};
  if (args.dryRun !== false) return {dryRun: true, plan, confirmation: confirmations.issue(plan)};
  if (args.planHash !== hashPlan(plan)) throw Error('clip removal confirmation context changed');
  confirmations.consume(args.confirmationToken, args.planHash);
  return {dryRun: false, requested: plan, observed: await bridge.request(method, plan)};
}
