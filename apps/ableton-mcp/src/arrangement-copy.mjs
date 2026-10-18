import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function copyArrangementClip(bridge,confirmations,args){
 if(!Number.isSafeInteger(args.expectedStateVersion)||typeof args.name!=='string'||!args.name.trim()||args.name.length>128||/[\x00-\x1f\x7f]/u.test(args.name)||!Number.isFinite(args.startBeats)||args.startBeats<0||args.startBeats>Number.MAX_SAFE_INTEGER)throw Error('fresh expectedStateVersion, finite destination and explicit valid name required');
 const ids={trackId:args.trackId,clipId:args.clipId,destinationTrackId:args.destinationTrackId,startBeats:args.startBeats};
 const before=await bridge.request('get_arrangement_copy_source',ids);assertExpectedState(args,before);
 if(!before.identityToken||before.clipId!==args.clipId||before.destinationTrackId!==args.destinationTrackId||before.startBeats!==args.startBeats)throw Error('updated native Arrangement copy context required');
 const plan={method:'copy_arrangement_clip_to_track',...ids,name:args.name,expectedStateVersion:args.expectedStateVersion,before};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('Arrangement copy confirmation context changed');
 confirmations.consume(args.confirmationToken,args.planHash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
