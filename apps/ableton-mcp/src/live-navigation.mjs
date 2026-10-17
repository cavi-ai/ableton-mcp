import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function showLiveObject(bridge, confirmations, args) {
  if (typeof args.trackId !== 'string' || !/^(?:(?:track|return)-(?:0|[1-9][0-9]*)|master)$/.test(args.trackId)) {
    throw Error('canonical Live navigation owner required');
  }
  if (!['Session', 'Arranger'].includes(args.view) || args.clipId !== undefined && args.deviceId !== undefined) {
    throw Error('one exact navigation selector and Session/Arranger view required');
  }
  if (args.clipId !== undefined) {
    const suffix = typeof args.clipId === 'string' && args.clipId.startsWith(args.trackId + ':')
      ? args.clipId.slice(args.trackId.length + 1) : '';
    if (!/^track-/.test(args.trackId) || !/^(clip|arrangement-clip)-(0|[1-9][0-9]*)$/.test(suffix)) {
      throw Error('canonical clip or Session slot required');
    }
    if (args.view !== (suffix.startsWith('arrangement-') ? 'Arranger' : 'Session')) {
      throw Error('navigation view does not match the clip location');
    }
  }
  if (args.deviceId !== undefined) {
    const suffix = typeof args.deviceId === 'string' && args.deviceId.startsWith(args.trackId + ':')
      ? args.deviceId.slice(args.trackId.length + 1) : '';
    if (!/^device-(0|[1-9][0-9]*)(\/(chain|return-chain)-(0|[1-9][0-9]*)\/device-(0|[1-9][0-9]*))*$/.test(suffix)) {
      throw Error('canonical device path required');
    }
  }
  const selector = {trackId: args.trackId, view: args.view,
    ...(args.clipId !== undefined ? {clipId: args.clipId} : {}),
    ...(args.deviceId !== undefined ? {deviceId: args.deviceId} : {})};
  const before = await bridge.request('get_live_navigation_context', selector);
  assertExpectedState({expectedStateVersion: args.expectedStateVersion}, before);
  if (typeof args.expectedSetFingerprint !== 'string' || before.setFingerprint !== args.expectedSetFingerprint) {
    throw Error('Live navigation Set changed');
  }
  if (typeof before.identityToken !== 'string' || !before.identityToken || !before.selection || !before.views || !before.controls ||
      !Array.isArray(before.deviceViews) || !Array.isArray(before.groupsToReveal) ||
      before.target?.trackId !== args.trackId || before.target.view !== args.view ||
      before.target.clipId !== args.clipId || before.target.deviceId !== args.deviceId) {
    throw Error('updated bridge Live navigation context required');
  }
  const plan = {method: 'show_live_object', ...selector, expectedStateVersion: args.expectedStateVersion, before};
  const warning = 'Changes selection, native views and control-surface focus; may unfold Group ancestors, expand devices and reveal Rack chains. '
    + 'Requests no playback, note, routing or device-parameter edits. Does not activate the desktop app or open a plug-in editor. '
    + 'Partial UI changes remain for inspection; do not replay a lost request or restore an old view over manual navigation.';
  if (args.dryRun !== false) return {dryRun: true, plan, warning, confirmation: confirmations.issue(plan)};
  const hash = hashPlan(plan);
  if (args.planHash !== hash) throw Error('Live navigation context changed; review a fresh plan');
  confirmations.consume(args.confirmationToken, hash);
  const observed = await bridge.request('show_live_object', plan);
  const receiptMatches = observed?.stateVersion === args.expectedStateVersion + 1 && observed.target !== undefined && hashPlan(observed.target) === hashPlan(before.target);
  const flags = ['targetIdentityRetained', 'selectionVerified', 'viewsVerified', 'deviceViewsVerified', 'controlsUnchanged'];
  if (!receiptMatches || observed?.showVerified === true && flags.some(key => observed[key] !== true)) {
    return {dryRun: false, requested: plan, observed: {...observed, bridgeReportedShowVerified: observed?.showVerified,
      showVerified: false, inspectionRequired: true,
      verificationError: 'Incomplete or changed native navigation receipt; inspect current selection and views before retrying'}};
  }
  return {dryRun: false, requested: plan, observed};
}
