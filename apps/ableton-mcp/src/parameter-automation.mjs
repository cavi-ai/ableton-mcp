import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

function target(args){
 if(typeof args.trackId!=='string'||!/^(master|(track|return)-(0|[1-9][0-9]*))$/.test(args.trackId))throw Error('canonical track, Return or master ID required');
 const request={trackId:args.trackId};
 if(args.deviceId!==undefined){
  if(typeof args.deviceId!=='string'||!args.deviceId.startsWith(`${args.trackId}:device-`))throw Error('exact device ID on the selected owner required');
  request.deviceId=args.deviceId;
 }
 if(args.parameterId!==undefined){
  const valid=request.deviceId?/^parameter-(0|[1-9][0-9]*)$/:/^(volume|pan|left|right|cueVolume|crossfader|send-(0|[1-9][0-9]*))$/;
  if(typeof args.parameterId!=='string'||!valid.test(args.parameterId))throw Error('exact observed parameterId required');
  request.parameterId=args.parameterId;
 }
 return request;
}

function ready(before,request){
 if(typeof before.identityToken!=='string'||!before.identityToken||before.trackId!==request.trackId||
  before.deviceId!==(request.deviceId??null)||before.parameterId!==request.parameterId||
  before.controls?.length!==1||before.controls[0].id!==request.parameterId)throw Error('updated native automation target context required');
 const p=before.controls[0],t=before.transport;
 if(p.supported!==true||p.reEnableSupported!==true||p.enabled!==true||
  p.automationState?.value!==2||p.automationState?.name!=='overridden')throw Error('select one supported enabled control with known overridden automation');
 if(before.frozen!==false||!t||t.arrangementRecord!==false||t.sessionRecord!==false||t.countingIn!==false)
  throw Error('resolve frozen or unknown target state, recording and count-in before handing back automation');
 if(!request.deviceId&&['pan','left','right'].includes(request.parameterId)&&before.panningMode!==(request.parameterId==='pan'?0:1))
  throw Error('selected pan control must match the known active native mode');
}

export async function parameterAutomation(bridge,confirmations,name,args){
 const request=target(args);
 if(name==='get_parameter_automation_context')return bridge.request(name,request);
 if(!request.parameterId||!Number.isInteger(args.expectedStateVersion))throw Error('parameterId and expectedStateVersion required');
 const before=await bridge.request('get_parameter_automation_context',request);
 assertExpectedState(args,before);ready(before,request);
 const plan={method:'re_enable_parameter_automation',...request,expectedStateVersion:args.expectedStateVersion,before};
 const scope=before.ownerType==='master'?'Main controls affect the entire routed mix. ':before.ownerType==='return'?'Return controls affect all audio routed through that Return. ':before.ownerType==='group'?'Group controls affect their routed descendants. ':'';
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:scope+
  'Hands one exact overridden control back to automation; its value may jump and mapped or routed material may change. Playback is preserved. This does not restore an envelope or establish an audible result. The native method is requested once, with bounded readback; partial work remains without automatic rollback or replay.'};
 const hash=hashPlan(plan);if(args.planHash!==hash)throw Error('confirmation plan hash mismatch: automation context changed');
 confirmations.consume(args.confirmationToken,hash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
