import {assertExpectedState} from './bridge-protocol.mjs';
import {guardedWrite} from './guarded-write.mjs';

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
  return guardedWrite(confirmations, plan, args, {mismatch: 'clip removal confirmation context changed', execute: () => bridge.request(method, plan)});
}
