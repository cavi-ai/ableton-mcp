import {hashPlan} from './confirmation-store.mjs';

export async function arrangementRecording(bridge,confirmations,name,args){
  if(name==='get_arrangement_take')return bridge.request(name,args);
  if(!Number.isInteger(args.expectedStateVersion))throw Error('expectedStateVersion is required');
  const starting=name==='record_arrangement_take';
  if(starting && (typeof args.trackId!=='string'||!/^track-(0|[1-9][0-9]*)$/.test(args.trackId)||
    !Number.isFinite(args.startBeats)||!Number.isFinite(args.endBeats)||args.startBeats<0||
    args.endBeats<=args.startBeats||args.endBeats-args.startBeats>512))throw Error('recording requires an ordinary track and increasing range of at most 512 beats');
  if(!starting && (typeof args.takeId!=='string'||!args.takeId||args.cancel!==undefined&&typeof args.cancel!=='boolean'))throw Error('takeId and optional boolean cancel required');
  const request=starting?{trackId:args.trackId,startBeats:args.startBeats,endBeats:args.endBeats}:{takeId:args.takeId,cancel:args.cancel??false};
  const read=await bridge.request(starting?'get_arrangement_recording_source':'get_arrangement_take',request);
  if(read.stateVersion!==args.expectedStateVersion || starting&&!read.identityToken || !starting&&read.takeId!==args.takeId)throw Error('Arrangement recording context changed or updated bridge required');
  // Clip ends and incoming performance advance while recording. Bind control ownership instead.
  const before=starting?read:{stateVersion:read.stateVersion,takeId:read.takeId,status:read.status,controlContext:read.controlContext};
  const plan={method:name,expectedStateVersion:args.expectedStateVersion,...request,before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:starting?
    'Starts global Arrangement recording and playback in this empty native punch range, then stops both. Disables loop, MIDI Arrangement Overdub and Automation Arm; changes loop bounds/playhead and punch switches. Leaves target armed, routing unchanged and setup controls in place. Other tracks may sound. Retains partial material; never blindly retry a lost start.':
    'Releases a stopped runtime handle while retaining clips and setup controls. Cancel true requests an early stop of owned recording and global playback. Changed ownership is reported without stopping user transport.'};
  if(args.planHash!==hashPlan(plan))throw Error('Arrangement take confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request(name,plan)};
}
