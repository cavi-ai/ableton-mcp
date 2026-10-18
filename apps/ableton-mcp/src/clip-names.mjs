import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export const renameArrangementClip=(bridge,confirmations,args)=>renameClip(bridge,confirmations,args,false);
export const renameSessionClip=(bridge,confirmations,args)=>renameClip(bridge,confirmations,args,true);

async function renameClip(bridge,confirmations,args,session){
 const limit=session?255:128;
 if(!Number.isSafeInteger(args.expectedStateVersion)||typeof args.name!=='string'||!args.name.trim()||args.name.length>limit||/[\x00-\x1f\x7f]/u.test(args.name))throw Error(`fresh expectedStateVersion and a nonempty name of at most ${limit} characters without controls required`);
 const ids={trackId:args.trackId,clipId:session?args.targetId:args.clipId},before=await bridge.request(session?'get_session_clip_name_context':'get_arrangement_clip_name_context',ids);
 assertExpectedState(args,before);
 if(before.clipId!==ids.clipId||typeof before.identityToken!=='string'||!before.identityToken||
    (session&&(before.clip?.id!==ids.clipId||before.clip?.hasClip!==true)))throw Error('updated native clip identity required');
 const plan={method:session?'rename_session_object':'rename_arrangement_clip',...ids,expectedStateVersion:args.expectedStateVersion,name:args.name,before,
  ...(session?{target:{targetType:'clip',trackId:ids.trackId,targetId:ids.clipId,previousName:before.clip.name,name:args.name}}:{})};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('clip name confirmation context changed');
 confirmations.consume(args.confirmationToken,args.planHash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
