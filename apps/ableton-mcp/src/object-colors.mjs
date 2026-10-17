import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

const objectId = /^(?:master|(?:track|return|scene)-(?:0|[1-9][0-9]*)|track-(?:0|[1-9][0-9]*):(?:clip|arrangement-clip)-(?:0|[1-9][0-9]*))$/;
const rgb = /^#[0-9A-Fa-f]{6}$/;
function validColor(item) {
  return item?.supported === true && (typeof item.color === 'string' && rgb.test(item.color) && Number.isInteger(item.colorIndex) && item.colorIndex >= 0 ||
    item.objectId.startsWith('scene-') && item.color === null && (item.colorIndex === null || item.colorIndex === -1));
}
function ids(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64 ||
      values.some(key => typeof key !== 'string' || !objectId.test(key)) || new Set(values).size !== values.length) {
    throw Error('one to 64 unique canonical color object IDs required');
  }
  return values;
}
export async function getLiveObjectColors(bridge, args) {
  return bridge.request('get_live_object_colors', {objectIds: ids(args.objectIds)});
}
export async function setLiveObjectColors(bridge, confirmations, args) {
  if (!Array.isArray(args.changes) || args.changes.some(c => !c || Object.keys(c).sort().join(',') !== 'color,objectId' || typeof c.color !== 'string' || !rgb.test(c.color))) {
    throw Error('explicit objectId and six-digit RGB color required for every change');
  }
  const objectIds = ids(args.changes.map(c => c.objectId));
  const changes = args.changes.map(c => ({objectId: c.objectId, color: c.color.toUpperCase()}));
  const before = await getLiveObjectColors(bridge, {objectIds});
  assertExpectedState({expectedStateVersion: args.expectedStateVersion}, before);
  if (typeof args.expectedSetFingerprint !== 'string' || before.setFingerprint !== args.expectedSetFingerprint) throw Error('color edit Set changed');
  if (typeof before.identityToken !== 'string' || !before.identityToken || !before.selection || !Array.isArray(before.objects) || before.objects.length !== changes.length ||
      before.objects.some((item,i) => item?.objectId !== objectIds[i] || !validColor(item))) {
    throw Error('updated native color context required; unsupported color target');
  }
  const plan = {method: 'set_live_object_colors', changes, expectedStateVersion: args.expectedStateVersion, before};
  const warning = 'Changes only explicit object colors in one Live undo step; native palette colors may differ from requested RGB. Track color inheritance may affect Rack-chain appearance. Partial changes remain for inspection; never replay a lost request or undo over intervening manual edits.';
  if (args.dryRun !== false) return {dryRun: true, plan, warning, confirmation: confirmations.issue(plan)};
  const hash = hashPlan(plan);
  if (args.planHash !== hash) throw Error('color targets or context changed; review a fresh plan');
  confirmations.consume(args.confirmationToken, hash);
  const observed = await bridge.request('set_live_object_colors', plan);
  const receiptValid = observed?.stateVersion === args.expectedStateVersion + 1 && Array.isArray(observed.objects) && observed.objects.length === changes.length &&
    observed.objects.every((item,i) => item?.objectId === changes[i].objectId && item.requestedColor === changes[i].color &&
      (item.supported === false && item.color === null || validColor(item)) &&
      item.exactMatch === (item.color === changes[i].color));
  const complete = observed?.writeCompleted !== true || receiptValid && observed.identityRetained === true && observed.selectionUnchanged === true &&
    observed.objects.every(item => item.supported === true && item.writeReturned === true && Number.isInteger(item.colorIndex) && item.colorIndex >= 0);
  if (!receiptValid || !complete) return {dryRun: false, requested: plan, observed: {...observed, bridgeReportedWriteCompleted: observed?.writeCompleted,
    writeCompleted: false, inspectionRequired: true, verificationError: 'Incomplete or contradictory native color receipt; inspect current colors before retrying'}};
  return {dryRun: false, requested: plan, observed};
}
