import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {MacLiveSetHost} from './live-set-host.mjs';
const execute=promisify(execFile),script=fileURLToPath(new URL('./live-recording-setup.js',import.meta.url)),focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));

export async function recordingSetup(bridge,confirmations,host,args,{observed,changes}){
  const read=()=>bridge.request('get_recording_setup_source',{}),before=await read();
  if(!before.identityToken||!before.filePath?.startsWith('/')||!before.setName||before.stateVersion!==args.expectedStateVersion||hashPlan(before.transport)!==hashPlan(observed))throw Error('saved Set and updated recording setup context required; re-read');
  if(before.transport.isPlaying!==false||before.recording?.arrangement!==false||before.recording.session!==false||before.recording.countingIn!==false)throw Error('stop authorized playback/recording before count-in preparation');
  const target={countInDuration:changes.countInDuration.value,metronome:changes.metronome?.value??before.transport.metronome};
  const plan={method:'set_transport_context',expectedStateVersion:args.expectedStateVersion,before,changes,
    warning:'Count-in preparation uses macOS English Live menus on a saved Set. Changes focus and requested count-in/metronome settings only. Does not start playback or recording. Partial changes are reported without rollback.'};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('recording setup confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  const recheck=async()=>{requestSignal()?.throwIfAborted();if(hashPlan(await read())!==hashPlan(before))throw Error('recording setup context changed before native input');};
  let prepared,ui,error,cleanup;
  try{
    prepared=await host.prepare(before,{beforePrepare:recheck,signal:requestSignal()});
    ui=await host.commit(before,prepared,target,{beforeCommit:recheck,signal:requestSignal()});
  }catch(failure){
    error=failure;prepared=failure.prepared??prepared;
    if(prepared)try{cleanup=await host.cancel(before,prepared);}catch(cancelError){cleanup={cancelled:false,error:cancelError.message};}
  }
  let after;
  try{after=await read();}catch(failure){error??=failure;}
  const expected=structuredClone(before);
  expected.transport.metronome=target.metronome;
  expected.transport.countInDuration={...expected.transport.countInDuration,value:target.countInDuration,
    name:before.transport.countInDuration.choices.find(c=>c.value===target.countInDuration)?.name};
  const transportVerified=!error&&ui?.popupClosed===true&&hashPlan(after)===hashPlan(expected);
  return {dryRun:false,requested:plan,observed:after?.transport??null,transportVerified,
    operationRequested:error?error.operationRequested??null:ui.operationRequested,ui,dialogCleanup:cleanup,
    ...(!transportVerified?{verificationError:error?.message??'native transport context did not match requested settings',
      pendingUserAction:prepared?cleanup?.cancelled!==true:!!error?.requiresInspection,
      limitation:'Inspect current native values and UI before continuing; no automatic rollback or replay.'}:{pendingUserAction:false})};
}

export class MacRecordingSetupHost{
  constructor({platform=process.platform,liveSetHost=new MacLiveSetHost(),run=execute}={}){this.platform=platform;this.liveSetHost=liveSetHost;this.run=run;this.busy=false;}
  async owner(source){
    if(this.platform!=='darwin')throw Object.assign(Error('count-in preparation requires macOS English Live'),{operationRequested:false});
    const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();
    if(processes.length!==1||processes[0].path!==executable)throw Object.assign(Error('exactly one expected Live app is required'),{operationRequested:false});
    return {pid:processes[0].pid,appPath};
  }
  async call(owner,source,input,signal){
    const result=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({...owner,filePath:source.filePath,setName:source.setName,baseline:source.transport,...input})],{timeout:10000,maxBuffer:131072,signal})).stdout);
    if(result.error)throw Object.assign(Error(result.error),{operationRequested:result.operationRequested,prepared:result.prepared,requiresInspection:result.requiresInspection});return result;
  }
  async prepare(source,{beforePrepare,signal}){
    if(this.busy)throw Object.assign(Error('another recording setup action is active'),{operationRequested:false});this.busy=true;
    try{
      const owner=await this.owner(source),view=await this.call(owner,source,{action:'inspect'},signal);
      const focused=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:view.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);
      if(!focused.focused)throw Object.assign(Error('Live did not become visible'),{operationRequested:false});
      await beforePrepare();return {...owner,...await this.call(owner,source,{action:'prepare',expectedMain:view},signal)};
    }catch(error){this.busy=false;throw error;}
  }
  async commit(source,prepared,target,{beforeCommit,signal}){
    try{await beforeCommit();const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Object.assign(Error('Live process changed'),{operationRequested:false});return await this.call(owner,source,{action:'commit',prepared,target},signal);}
    finally{this.busy=false;}
  }
  async cancel(source,prepared){try{const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Error('Live process changed');return await this.call(owner,source,{action:'cancel',prepared});}finally{this.busy=false;}}
}
