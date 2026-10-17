import {hashPlan} from './confirmation-store.mjs';

export async function sessionClipHold(bridge,confirmations,name,args){
 if(name==='get_session_clip_hold')return bridge.request(name,args);
 if(!Number.isInteger(args.expectedStateVersion))throw Error('expectedStateVersion is required');
 const starting=name==='hold_session_clip';
 if(starting&&(!Number.isFinite(args.durationSeconds)||args.durationSeconds<.25||args.durationSeconds>8))throw Error('hold duration must be between 0.25 and 8 seconds');
 if(starting&&args.allowPlaying!==undefined&&typeof args.allowPlaying!=='boolean')throw Error('allowPlaying must be boolean');
 if(!starting&&(typeof args.holdId!=='string'||!args.holdId))throw Error('holdId is required');
 if(!starting&&args.cancel!==undefined&&typeof args.cancel!=='boolean')throw Error('cancel must be boolean');
 const target=starting?{trackId:args.trackId,clipId:args.clipId,allowPlaying:args.allowPlaying??false}:{holdId:args.holdId};
 const before=await bridge.request('get_session_clip_hold_source',target);
 if(before.stateVersion!==args.expectedStateVersion||!before.identityToken||
   (starting?(before.trackId!==args.trackId||before.clipId!==args.clipId):before.holdId!==args.holdId))throw Error('clip hold identity or state changed');
 const plan={method:name,...target,expectedStateVersion:args.expectedStateVersion,
  ...(starting?{durationSeconds:args.durationSeconds}:{cancel:args.cancel??false}),before};
 const warning=starting
  ?'Requests a Gate/Repeat press now and release on Live display ticks after a wall-clock duration, even without this client. Honors native quantization. Global playback must already be authorized and running. Session launch can override this track\'s Arrangement. Gate release may stop the clip; Repeat may continue. No global stop, mode restoration or other clip takeover. Concurrent manual/controller input on this button cannot be distinguished and may be released. Command receipts are not raw button-state or audible-performance verification. Inspect retained handles after uncertainty; never replay a press blindly.'
  :'Cancel requests release of the retained native clip only. A failed release retains its handle and track reservation until an explicit cancel retry succeeds. Finishing a released terminal handle forgets runtime evidence; it does not stop a continuing Repeat clip. Inspect cleanupErrors and actual playback before continuing.';
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning};
 if(args.planHash!==hashPlan(plan))throw Error('confirmation plan hash mismatch: clip hold context changed');
 confirmations.consume(args.confirmationToken,args.planHash);
 return {dryRun:false,requested:plan,observed:await bridge.request(name,plan)};
}
