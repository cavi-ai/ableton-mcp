import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {readTakeLaneContext} from './take-lanes.mjs';
import {MacLiveSetHost} from './live-set-host.mjs';

const execute=promisify(execFile),script=fileURLToPath(new URL('./live-take-lane-audition.js',import.meta.url)),
  focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));

function assertUi(source,ui){
  if (!Number.isSafeInteger(ui?.pid) || ui.pid<=0 || !Number.isSafeInteger(ui.windowId) || ui.windowId<=0 ||
      typeof ui.documentPath!=='string' || !ui.documentPath.startsWith('/') || typeof ui.visible!=='boolean' || !['session','arrangement','unknown'].includes(ui.mode) || !Array.isArray(ui.lanes) ||
      ui.visible && (ui.mode!=='arrangement' || ui.lanes.length!==source.lanes.length || ui.lanes.some((lane,index)=>
        lane.index!==index || lane.name!==source.lanes[index].name || typeof lane.audition!=='boolean') ||
        ui.lanes.filter(l=>l.audition).length>1)) throw Error('native take-lane UI context is unavailable or inconsistent');
}

async function context(bridge,host,args){
  const source=await readTakeLaneContext(bridge,{trackId:args.trackId});
  if(typeof source.uiTrackPath!=='string' || !/^ArrangementView\.(?:(?:GroupTrack\[[0-9]+\])\.)*Track\[[0-9]+\]$/.test(source.uiTrackPath) ||
    !Array.isArray(source.uiAncestors) || typeof source.setName!=='string' || !source.setName) throw Error('updated bridge take-lane UI path required');
  const audition=await host.inspect(source);assertUi(source,audition);
  if(hashPlan(source)!==hashPlan(await readTakeLaneContext(bridge,{trackId:args.trackId})))throw Error('native take context changed during UI inspection');
  return {source,audition};
}

export async function takeLaneAudition(method,bridge,confirmations,host,args){
  requestSignal()?.throwIfAborted();
  const before=await context(bridge,host,args);
  if(method==='get_take_lane_audition_context')return {...before.source,audition:before.audition,scope:'entire_take_lane'};
  const source=before.source,track=source.track,recording=source.recording;
  if(!Number.isInteger(args.expectedStateVersion)||args.expectedStateVersion!==source.stateVersion)throw Error('expectedStateVersion must match current native context');
  if(!source.supported || !source.lanes.length || track.armed!==false || track.frozen!==false || track.firedSlotIndex>=0 ||
    recording.arrangement!==false || recording.session!==false || source.uiAncestors.some(a=>a.folded!==false)) {
    throw Error('take audition requires stored lanes, recording off, an unarmed unfrozen target and unfolded ancestor groups');
  }
  let index=null;
  if(method==='select_take_lane_audition'){
    if(!before.audition.visible)throw Error('take lanes must be visible; confirm show_take_lanes first');
    if(args.laneId!==null){
      if(typeof args.laneId!=='string' || !args.laneId.startsWith(args.trackId+':take-lane-') ||
        !/^:take-lane-(?:0|[1-9][0-9]*)$/.test(args.laneId.slice(args.trackId.length)))throw Error('canonical laneId or explicit null required');
      index=source.lanes.findIndex(l=>l.id===args.laneId);if(index<0)throw Error('laneId is unavailable');
    }
    const current=before.audition.lanes.findIndex(l=>l.audition);
    if((current<0?null:current)===index)throw Error('requested take audition selection is already active');
  }else if(method!=='show_take_lanes')throw Error('unknown take audition operation');
  const plan={method,trackId:args.trackId,expectedStateVersion:args.expectedStateVersion,
    ...(method==='select_take_lane_audition'?{laneId:args.laneId}:{}),before,
    warning:method==='show_take_lanes'?'Shows Arrangement and this track take lanes; changes visible UI and focus. Unfold ancestor groups separately.':
      'Selects audition for the entire lane, or returns this track to the comp with null. Does not start playback or change comp selections, track mutes, solos or routing. Other tracks may sound. Notes, envelopes and source-file bytes are not compared.'};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('take audition confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  let attempted=false,ui;
  const beforeAction=async()=>{
    requestSignal()?.throwIfAborted();
    if(hashPlan(await context(bridge,host,args))!==hashPlan(before))throw Error('take audition context changed before native action');
    attempted=true;
  };
  try{
    ui=method==='show_take_lanes'?await host.show(source,before.audition,{beforeAction,signal:requestSignal()}):
      await host.select(source,before.audition,index,{beforeAction,signal:requestSignal()});
    assertUi(source,ui);
    const after=await readTakeLaneContext(bridge,{trackId:args.trackId}),contextUnchanged=hashPlan(after)===hashPlan(source),
      active=ui.lanes.findIndex(l=>l.audition),selectedLaneId=active<0?null:source.lanes[active]?.id,
      selectionVerified=contextUnchanged&&ui.visible&&(method==='show_take_lanes'||(active<0?null:active)===index);
    return {dryRun:false,requested:plan,operationRequested:true,selectionVerified,contextUnchanged,selectedLaneId,
      audition:ui,materialPreservationVerified:false,scope:'entire_take_lane',
      ...(!selectionVerified?{verificationError:'Inspect the visible audition selection and native context before continuing; no automatic rollback.'}:{})};
  }catch(error){
    return {dryRun:false,requested:plan,operationRequested:error.actionRequested===false?false:attempted?null:false,
      selectionVerified:false,materialPreservationVerified:false,
      verificationError:`${error.message}; inspect take visibility and audition state before retrying; no automatic rollback.`};
  }
}

export class MacTakeLaneAuditionHost {
  constructor({platform=process.platform,liveSetHost=new MacLiveSetHost(),run=execute}={}){
    this.platform=platform;this.liveSetHost=liveSetHost;this.run=run;this.busy=false;
  }
  async owner(source){
    if(this.platform!=='darwin')throw Error('native take-lane audition requires macOS');
    const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),
      processes=await this.liveSetHost.runningProcesses();
    if(processes.length!==1||processes[0].path!==executable)throw Error('exactly one instance of the expected Live app is required');
    return {pid:processes[0].pid,appPath};
  }
  async call(owner,source,input,signal){
    const result=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({
      ...owner,filePath:source.filePath,setName:source.setName,trackName:source.track.name,uiTrackPath:source.uiTrackPath,laneNames:source.lanes.map(l=>l.name),...input
    })],{timeout:10000,maxBuffer:262144,signal})).stdout);
    if(result.error)throw Object.assign(Error(result.error),{actionRequested:result.actionRequested});
    return result.ui??result;
  }
  async inspect(source){const owner=await this.owner(source);return this.call(owner,source,{action:'inspect'},requestSignal());}
  async operate(action,source,expectedUI,index,{beforeAction,signal}={}){
    if(this.busy)throw Object.assign(Error('another native take audition action is active'),{actionRequested:false});
    this.busy=true;
    try{
      const owner=await this.owner(source);
      if(owner.pid!==expectedUI.pid)throw Object.assign(Error('Live process changed'),{actionRequested:false});
      const focused=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',focusScript,
        JSON.stringify({...owner,windowId:expectedUI.windowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);
      if(!focused.focused)throw Object.assign(Error('Live did not become visible'),{actionRequested:false});
      await beforeAction();
      return await this.call(owner,source,{action,expectedUI,targetIndex:index},signal);
    }finally{this.busy=false;}
  }
  show(source,ui,options){return this.operate('show',source,ui,null,options);}
  select(source,ui,index,options){return this.operate('select',source,ui,index,options);}
}
