import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {MacLiveSetHost} from './live-set-host.mjs';
const execute=promisify(execFile),script=fileURLToPath(new URL('./live-track-freeze.js',import.meta.url)),focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));

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
    if(prepared&&failure.freezeRequested===false)try{cleanup=await host.cancel(before,prepared);}catch(cancelError){cleanup={cancelled:false,error:cancelError.message};}
  }
  let after;
  try{after=await read();}catch(failure){error??=failure;}
  const freezeRequested=error?error.freezeRequested??ui?.freezeRequested??null:ui.freezeRequested;
  const freezeVerified=!error&&ui?.uiIdle===true&&ui.popupClosed===true&&after?.identityToken===before.identityToken&&after.filePath===before.filePath&&
    after.freeze?.frozen===args.frozen&&hashPlan(after.otherFreezeStates)===hashPlan(before.otherFreezeStates)&&Object.values(after.readiness).every(v=>v===false);
  return {dryRun:false,requested:plan,observed:after?{stateVersion:after.stateVersion,trackId:args.trackId,freeze:after.freeze}:null,
    freeze:after?.freeze??null,freezeRequested,freezeVerified,materialPreservationVerified:false,
    ui,dialogCleanup:cleanup,pendingUserAction:!freezeVerified&&!!(freezeRequested!==false||error?.requiresInspection&&!prepared||prepared&&cleanup?.cancelled!==true),
    limitation:'Freeze readback does not prove audio equivalence, reduced CPU load, saved state or complete material preservation. Inspect the native state after interruption; never replay an uncertain command.',
    ...(!freezeVerified?{verificationError:error?.message??'requested freeze state or idle native UI did not verify'}:{})};
}

export class MacTrackFreezeHost{
  constructor({platform=process.platform,liveSetHost=new MacLiveSetHost(),run=execute}={}){this.platform=platform;this.liveSetHost=liveSetHost;this.run=run;this.busy=false;}
  async owner(source){
    if(this.platform!=='darwin')throw Object.assign(Error('track freeze requires macOS English Live'),{freezeRequested:false});
    const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();
    if(processes.length!==1||processes[0].path!==executable)throw Object.assign(Error('exactly one expected Live app is required'),{freezeRequested:false});
    return {pid:processes[0].pid,appPath};
  }
  async call(owner,source,input,signal){
    const result=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({...owner,filePath:source.filePath,setName:source.setName,uiPath:source.uiPath,trackName:source.name,...input})],{timeout:30000,maxBuffer:131072,signal})).stdout);
    if(result.error)throw Object.assign(Error(result.error),{freezeRequested:result.freezeRequested,prepared:result.prepared?{...owner,...result.prepared}:null,requiresInspection:result.requiresInspection});return result;
  }
  async prepare(source,{beforePrepare,signal}){
    if(this.busy)throw Object.assign(Error('another freeze action is active'),{freezeRequested:false});this.busy=true;
    let preparationDispatched=false;
    try{
      const owner=await this.owner(source),view=await this.call(owner,source,{action:'inspect'},signal);
      const focused=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:view.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);
      if(!focused.focused)throw Error('Live did not become visible');
      await beforePrepare();preparationDispatched=true;return {...owner,...await this.call(owner,source,{action:'prepare',expectedMain:view,frozen:source.freeze.frozen},signal)};
    }catch(error){this.busy=false;error.freezeRequested??=false;if(preparationDispatched)error.requiresInspection=true;throw error;}
  }
  async commit(source,prepared,frozen,{beforeCommit,signal}){
    try{await beforeCommit();const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Object.assign(Error('Live process changed'),{freezeRequested:false});return await this.call(owner,source,{action:'commit',prepared,frozen},signal);}
    finally{this.busy=false;}
  }
  async cancel(source,prepared){try{const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Error('Live process changed');return await this.call(owner,source,{action:'cancel',prepared});}finally{this.busy=false;}}
}
