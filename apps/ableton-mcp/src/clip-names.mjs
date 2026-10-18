import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function renameArrangementClip(bridge,confirmations,args){
 if(!Number.isSafeInteger(args.expectedStateVersion)||typeof args.name!=='string'||!args.name.trim()||args.name.length>128||/[\x00-\x1f\x7f]/u.test(args.name))throw Error('fresh expectedStateVersion and a nonempty name of at most 128 characters without controls required');
 const ids={trackId:args.trackId,clipId:args.clipId},before=await bridge.request('get_arrangement_clip_name_context',ids);
 assertExpectedState(args,before);
 if(before.clipId!==args.clipId||typeof before.identityToken!=='string'||!before.identityToken)throw Error('updated native Arrangement clip identity required');
 const plan={method:'rename_arrangement_clip',...ids,expectedStateVersion:args.expectedStateVersion,name:args.name,before};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('Arrangement clip name confirmation context changed');
 confirmations.consume(args.confirmationToken,args.planHash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
