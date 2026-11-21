import {assertExpectedState} from './bridge-protocol.mjs';
import {guardedWrite} from './guarded-write.mjs';

export async function captureSessionScene(bridge,confirmations,args){
  if(!Number.isSafeInteger(args.expectedStateVersion)||typeof args.name!=='string'||!args.name.trim()||args.name.length>128||/[\x00-\x1f\x7f]/u.test(args.name)||!/^scene-(0|[1-9][0-9]*)$/u.test(args.afterSceneId))throw Error('fresh expectedStateVersion, canonical selected afterSceneId and explicit valid name required');
  const before=await bridge.request('get_session_scene_capture_context',{afterSceneId:args.afterSceneId});assertExpectedState(args,before);
  if(!before.identityToken||before.afterSceneId!==args.afterSceneId)throw Error('updated native Session scene capture context required');
  const plan={method:'capture_session_scene',launchesCapturedScene:true,afterSceneId:args.afterSceneId,name:args.name,expectedStateVersion:args.expectedStateVersion,before};
  return guardedWrite(confirmations,plan,args,{mismatch:'Session scene capture confirmation context changed',execute:()=>bridge.request(plan.method,plan)});
}
