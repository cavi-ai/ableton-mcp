import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function armTrack(bridge,confirmations,args){
  if(typeof args.trackId!=='string'||!/^track-(0|[1-9][0-9]*)$/.test(args.trackId))throw Error('canonical ordinary trackId required');
  if(typeof args.armed!=='boolean')throw Error('armed must be a boolean');
  const before=await bridge.request('get_track_arm_context',{trackId:args.trackId});
  assertExpectedState(args,before);
  if(before.trackId!==args.trackId||before.target?.id!==args.trackId||typeof before.identityToken!=='string'||!before.identityToken)throw Error('updated native track arm identity required');
  if(before.readyToChange!==true||!Array.isArray(before.reasons)||before.reasons.length)throw Error('track arming refused: '+(before.reasons??['readiness unavailable']).join(', '));
  const plan={method:'arm_track',trackId:args.trackId,armed:args.armed,expectedStateVersion:args.expectedStateVersion,before,
    warning:'Arming prepares live input and can affect monitoring; it is not a recording or proof of signal. Other arms and input controls are bound. Inspect verified and partial outcomes; no rollback or replay.'};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('track arm confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request('arm_track',plan)};
}
