import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {MacTrackMenuHost} from './track-menu.mjs';

export async function trackFreeze(bridge,confirmations,host,args){
  const read=()=>bridge.request('get_track_freeze_source',{trackId:args.trackId}),before=await read();
  if(!before.filePath?.startsWith('/')||!before.identityToken||!before.setName)throw Error('saved Set and updated native freeze context required');
  if(before.stateVersion!==args.expectedStateVersion)throw Error('track freeze state version changed');
  if(!before.freeze?.supported)throw Error('native freeze state is unavailable');
  if(before.freeze.frozen===args.frozen)throw Error('track is already in the requested freeze state');
  if(Object.values(before.readiness).some(v=>v!==false))throw Error('freeze requires stopped playback/recording, an unarmed target and no pending launches');
  if(args.frozen&&before.clipCount===0)throw Error('freeze requires a track with clips');
  if(args.frozen&&before.realtimeDevices?.length)throw Error('external hardware rendering requires preparation in Live');
  const plan={method:'set_track_freeze_state',trackId:args.trackId,expectedStateVersion:args.expectedStateVersion,before,frozen:args.frozen,
    contentMutationRisk:{kind:'rendered_track_audio',freezes:args.frozen,parameterRollbackRestoresContent:false},
    warning:'Uses macOS English Live on a saved Set. Changes focus and navigates visible track headers, leaving only the requested track selected before the command. Freezing renders Session and Arrangement clips and locks some edits until unfrozen. Exposed notes, timing and device/mixer values are bound; automation envelopes, hidden plug-in state and external file bytes are not. Does not bounce, delete, save or start playback. Unknown outcomes require inspection, never replay or rollback.'};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('freeze confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  const recheck=async()=>{try{requestSignal()?.throwIfAborted();if(hashPlan(await read())!==hashPlan(before))throw Error('freeze context changed before native command');}catch(error){throw Object.assign(error,{freezeRequested:false});}};
  let prepared,ui,error,cleanup;
  try{
    prepared=await host.prepare(before,{beforePrepare:recheck,signal:requestSignal()});
    ui=await host.commit(before,prepared,args.frozen,{beforeCommit:async()=>{await recheck();if((await bridge.request('get_selection_context',{})).selectedTrack?.id!==args.trackId)throw Object.assign(Error('native selected track changed before freeze'),{freezeRequested:false});},signal:requestSignal()});
  }catch(failure){
    error=failure;prepared=failure.prepared??prepared;
    if(prepared&&(failure.freezeRequested??failure.operationRequested)===false)try{cleanup=await host.cancel(before,prepared);}catch(cancelError){cleanup={cancelled:false,error:cancelError.message};}
  }
  let after;
  try{after=await read();}catch(failure){error??=failure;}
  const freezeRequested=error?error.freezeRequested??error.operationRequested??ui?.freezeRequested??ui?.operationRequested??null:ui.freezeRequested??ui.operationRequested;
  const freezeVerified=!error&&ui?.uiIdle===true&&ui.popupClosed===true&&after?.identityToken===before.identityToken&&after.filePath===before.filePath&&
    after.freeze?.frozen===args.frozen&&hashPlan(after.otherFreezeStates)===hashPlan(before.otherFreezeStates)&&Object.values(after.readiness).every(v=>v===false);
  return {dryRun:false,requested:plan,observed:after?{stateVersion:after.stateVersion,trackId:args.trackId,freeze:after.freeze}:null,
    freeze:after?.freeze??null,freezeRequested,freezeVerified,materialPreservationVerified:false,
    ui,dialogCleanup:cleanup,pendingUserAction:!freezeVerified&&!!(freezeRequested!==false||error?.requiresInspection&&!prepared||prepared&&cleanup?.cancelled!==true),
    limitation:'Freeze readback does not prove audio equivalence, reduced CPU load, saved state or complete material preservation. Inspect the native state after interruption; never replay an uncertain command.',
    ...(!freezeVerified?{verificationError:error?.message??'requested freeze state or idle native UI did not verify'}:{})};
}

export class MacTrackFreezeHost extends MacTrackMenuHost {
  constructor(options={}){super({...options,operation:'freeze'});}
}
