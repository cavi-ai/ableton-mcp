import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function renameSessionObject(bridge,confirmations,args){
  if(!['track','return','scene'].includes(args.targetType)||!Number.isSafeInteger(args.expectedStateVersion))throw Error('exact session object type and fresh expectedStateVersion required');
  if(typeof args.name!=='string'||!args.name.trim()||args.name.length>255)throw Error('name requires 1 to 255 characters');
  const ids={targetType:args.targetType,targetId:args.targetId};
  const before=await bridge.request('get_session_object_name_context',ids);
  assertExpectedState(args,before);
  if(before.targetType!==ids.targetType||before.targetId!==ids.targetId||before.object?.id!==ids.targetId||typeof before.object?.name!=='string'||typeof before.identityToken!=='string'||!before.identityToken)throw Error('updated native session object identity required');
  const plan={method:'rename_session_object',expectedStateVersion:args.expectedStateVersion,before,
    target:{...ids,previousName:before.object.name,name:args.name}};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('session object name confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
