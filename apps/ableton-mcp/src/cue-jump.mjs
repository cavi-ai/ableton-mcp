import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function jumpToCuePoint(bridge,confirmations,args){
 if(!Number.isSafeInteger(args.expectedStateVersion)||typeof args.cuePointId!=='string'||!/^cue-(0|[1-9][0-9]*)$/.test(args.cuePointId))throw Error('canonical cue point and fresh expectedStateVersion required');
 const before=await bridge.request('get_arrangement_cue_jump_context',{cuePointId:args.cuePointId});
 assertExpectedState(args,before);
 if(before.cuePointId!==args.cuePointId||before.cuePoint?.id!==args.cuePointId||typeof before.identityToken!=='string'||!before.identityToken)throw Error('updated native cue point identity required');
 const plan={method:'jump_to_arrangement_cue_point',cuePointId:args.cuePointId,expectedStateVersion:args.expectedStateVersion,before};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('cue point jump confirmation context changed');
 confirmations.consume(args.confirmationToken,args.planHash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
