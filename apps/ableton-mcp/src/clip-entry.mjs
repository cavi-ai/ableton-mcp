import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function setSessionClipEntry(bridge,confirmations,args){
 if(!Number.isSafeInteger(args.expectedStateVersion)||!['beats','seconds'].includes(args.unit)||typeof args.start!=='number'||!Number.isFinite(args.start))throw Error('fresh expectedStateVersion, explicit native unit and finite start required');
 const ids={trackId:args.trackId,clipId:args.clipId},before=await bridge.request('get_session_clip_entry_context',ids);
 assertExpectedState(args,before);
 if(before.trackId!==ids.trackId||before.clipId!==ids.clipId||typeof before.identityToken!=='string'||!before.identityToken||!before.content||before.unit!==args.unit||!Number.isFinite(before.end)||args.start>=before.end||(args.unit==='seconds'&&args.start<0))throw Error('updated native Session entry context and a position before its retained end in the observed unit required');
 const plan={method:'set_session_clip_entry',...ids,expectedStateVersion:args.expectedStateVersion,unit:args.unit,start:args.start,before};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('Session entry confirmation context changed');
 confirmations.consume(args.confirmationToken,args.planHash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
