import {hashPlan} from './confirmation-store.mjs';

export async function sessionArrangementRecording(bridge,confirmations,name,args){
  if(name==='get_session_arrangement_recording')return bridge.request(name,args);
  if(!Number.isInteger(args.expectedStateVersion))throw Error('expectedStateVersion is required');
  const starting=name==='record_session_arrangement';
  if(starting&&(!Number.isFinite(args.startBeats)||!Number.isFinite(args.endBeats)||args.startBeats<0||
      args.endBeats<=args.startBeats||args.endBeats-args.startBeats>512))throw Error('recording requires an increasing range of at most 512 beats');
  if(!starting&&(typeof args.recordingId!=='string'||!args.recordingId||args.cancel!==undefined&&typeof args.cancel!=='boolean'))
    throw Error('recordingId and optional boolean cancel are required');
  const input=starting?{startBeats:args.startBeats,endBeats:args.endBeats}:{recordingId:args.recordingId,cancel:args.cancel??false};
  const current=await bridge.request(starting?'get_session_arrangement_source':'get_session_arrangement_recording',input);
  if(current.stateVersion!==args.expectedStateVersion||starting&&!current.identityToken||!starting&&current.recordingId!==args.recordingId)
    throw Error('Session Arrangement context changed or updated bridge required');
  const before=starting?current:{stateVersion:current.stateVersion,recordingId:current.recordingId,controlContext:current.controlContext};
  const plan={method:name,...input,expectedStateVersion:args.expectedStateVersion,before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:starting
    ?'Sets and verifies the insert marker at the already prepared playhead after every existing Arrangement clip, then starts global Arrangement recording and playback. Leaves the marker at the requested start. All track arms must remain off. Records native Session clip choices, not input or requested knob/mixer automation. Requests global record/transport stop at endBeats or a 300-second wall-clock limit on Live display ticks while scope remains owned, including without this client. Not sample-accurate; partial clips and endpoint overhang remain. Changed scope relinquishes cleanup; inspect retained handles after uncertainty, never replay a start.'
    :'Releases a settled runtime handle and retains all clips. Cancel true explicitly requests early global Arrangement recording and transport stop under the current unchanged recording scope. Incoming clip lengths do not invalidate stop confirmation. Changed arms/topology/recording controls are preserved; unresolved recording remains explicit.'};
  if(args.planHash!==hashPlan(plan))throw Error('Session Arrangement confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request(name,plan)};
}
