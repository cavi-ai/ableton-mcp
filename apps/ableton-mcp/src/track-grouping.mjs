import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {MacLiveSetHost} from './live-set-host.mjs';
const execute=promisify(execFile),script=fileURLToPath(new URL('./live-track-grouping.js',import.meta.url)),focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));
const trackId=/^track-(0|[1-9][0-9]*)$/;
function validIds(ids){return Array.isArray(ids)&&ids.length>=2&&ids.length<=64&&ids.every((id,i)=>typeof id==='string'&&trackId.test(id)&&(i===0||Number(id.slice(6))===Number(ids[i-1].slice(6))+1));}
function checkedStatus(observed,groupingId){
 const flags=['originalOrderPreserved','membershipVerified','materialPreserved','routingVerified','controlsPreserved'];
 const members=observed?.members,sourceIds=members?.map?.(m=>m?.sourceTrackId);
 const valid=observed?.groupingId===groupingId&&observed.groupVerified!==true||observed?.groupingId===groupingId&&
  flags.every(k=>observed[k]===true)&&validIds(sourceIds)&&observed.group?.isGroup===true&&observed.group.id===sourceIds[0]&&
  members.every((m,i)=>m.trackId==='track-'+(Number(sourceIds[i].slice(6))+1)&&m.materialPreserved===true);
 if(!valid)return {...observed,bridgeReportedGroupVerified:observed?.groupVerified,groupVerified:false,inspectionRequired:true,verificationError:'Incomplete native grouping receipt; inspect current tracks and retained handle'};
 return observed;
}
export async function getTrackGroupingStatus(bridge,args){
 if(typeof args.groupingId!=='string'||!args.groupingId)throw Error('retained groupingId required');
 return checkedStatus(await bridge.request('get_track_grouping_status',{groupingId:args.groupingId}),args.groupingId);
}
export async function groupTracks(bridge,confirmations,host,args){
 if(!validIds(args.trackIds))throw Error('two to 64 consecutive canonical track IDs in Live order required');
 const read=()=>bridge.request('get_track_grouping_source',{trackIds:args.trackIds}),before=await read();
 if(before.stateVersion!==args.expectedStateVersion)throw Error('grouping state version changed');
 if(typeof args.expectedSetFingerprint!=='string'||before.setFingerprint!==args.expectedSetFingerprint)throw Error('grouping Set changed');
 if(typeof before.groupingId!=='string'||!before.groupingId||!before.filePath?.startsWith('/')||!before.setName||!Array.isArray(before.targets)||before.targets.length!==args.trackIds.length||
  before.targets.some((t,i)=>t.trackId!==args.trackIds[i]||typeof t.name!=='string'||!/^\.Track\[(0|[1-9][0-9]*)\]$/.test(t.uiPath)||typeof t.contentSha256!=='string'))throw Error('updated saved-Set grouping context required');
 const warning='Creates a real Group on macOS English Live from stopped, unarmed, unfrozen consecutive root tracks currently feeding Main. Changes native selection and routes requested outputs through the new Group to Main. Track IDs at and after insertion shift; re-read every affected ID. Exposed target material and existing mixer/routing controls are checked; automation, hidden plug-in state and file bytes are excluded. No playback, saving, deletion, automatic undo or ungrouping. Retain groupingId to inspect a lost response; never repeat an uncertain command.';
 const plan={method:'group_tracks',trackIds:args.trackIds,expectedStateVersion:args.expectedStateVersion,before,warning};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 const hash=hashPlan(plan);if(args.planHash!==hash)throw Error('grouping context changed; review a fresh plan');confirmations.consume(args.confirmationToken,hash);
 const recheck=async()=>{try{requestSignal()?.throwIfAborted();if(hashPlan(await read())!==hashPlan(before))throw Error('grouping context changed before native command');}catch(error){throw Object.assign(error,{groupRequested:false});}};
 let prepared,ui,error,cleanup,observed;
 try{prepared=await host.prepare(before,{beforePrepare:recheck,signal:requestSignal()});ui=await host.commit(before,prepared,{beforeCommit:recheck,signal:requestSignal()});}
 catch(failure){error=failure;prepared=failure.prepared??prepared;if(prepared&&failure.groupRequested===false)try{cleanup=await host.cancel(before,prepared);}catch(failure){cleanup={cancelled:false,error:failure.message};}}
 try{observed=await getTrackGroupingStatus(bridge,{groupingId:before.groupingId});}catch(failure){error??=failure;}
 const requested=error?error.groupRequested??ui?.groupRequested??null:ui?.groupRequested??null;
 const verified=!error&&ui?.groupRequested===true&&ui.popupClosed===true&&ui.uiIdle===true&&observed?.groupVerified===true&&observed.stateVersion===before.stateVersion+1&&
  observed.members.length===args.trackIds.length&&observed.members.every((m,i)=>m.sourceTrackId===args.trackIds[i]);
 return {dryRun:false,requested:plan,groupingId:before.groupingId,groupRequested:requested,groupVerified:verified,observed:observed??null,ui,dialogCleanup:cleanup,
  pendingUserAction:!verified&&(requested!==false||!!prepared&&cleanup?.cancelled!==true||error?.requiresInspection===true&&!prepared),
  ...(!verified?{verificationError:error?.message??observed?.verificationError??'Native grouping postconditions did not verify; inspect retained handle'}:{})};
}

export class MacTrackGroupingHost{
 constructor({platform=process.platform,liveSetHost=new MacLiveSetHost(),run=execute}={}){this.platform=platform;this.liveSetHost=liveSetHost;this.run=run;this.busy=false;}
 async owner(source){if(this.platform!=='darwin')throw Object.assign(Error('track grouping requires macOS English Live'),{groupRequested:false});const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();if(processes.length!==1||processes[0].path!==executable)throw Object.assign(Error('exactly one expected Live app required'),{groupRequested:false});return {pid:processes[0].pid,appPath};}
 async call(owner,source,input,signal){const result=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({...owner,filePath:source.filePath,setName:source.setName,targets:source.targets,visibleTracks:source.visibleTracks,operation:source.operation,...input})],{timeout:30000,maxBuffer:262144,signal})).stdout);if(result.error)throw Object.assign(Error(result.error),{groupRequested:result.groupRequested,prepared:result.prepared?{...owner,...result.prepared}:null,requiresInspection:result.requiresInspection});return result;}
 async prepare(source,{beforePrepare,signal}){
  if(this.busy)throw Object.assign(Error('another grouping action is active'),{groupRequested:false});this.busy=true;let dispatched=false;
  try{const owner=await this.owner(source),view=await this.call(owner,source,{action:'inspect'},signal),focus=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:view.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);if(!focus.focused)throw Error('Live did not become visible');await beforePrepare();dispatched=true;return {...owner,...await this.call(owner,source,{action:'prepare',expectedMain:view},signal)};}
  catch(error){this.busy=false;error.groupRequested??=false;if(dispatched)error.requiresInspection=true;throw error;}
 }
 async commit(source,prepared,{beforeCommit,signal}){try{await beforeCommit();const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Object.assign(Error('Live process changed'),{groupRequested:false});return await this.call(owner,source,{action:'commit',prepared},signal);}finally{this.busy=false;}}
 async cancel(source,prepared){try{const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Error('Live process changed');return await this.call(owner,source,{action:'cancel',prepared});}finally{this.busy=false;}}
}

function checkedUngroupStatus(observed,ungroupingId){
 const members=observed?.members,group=observed?.removedGroupId;
 const flags=['groupRemoved','originalOrderPreserved','membershipVerified','materialPreserved','routingVerified','controlsPreserved'];
 const complete=observed?.ungroupingId===ungroupingId&&observed.ungroupVerified!==true||observed?.ungroupingId===ungroupingId&&
  typeof group==='string'&&trackId.test(group)&&flags.every(k=>observed[k]===true)&&Array.isArray(members)&&
  Number.isInteger(observed.expectedMemberCount)&&observed.expectedMemberCount>=1&&observed.expectedMemberCount<=255&&members.length===observed.expectedMemberCount&&
  members.every((m,i)=>m.sourceTrackId==='track-'+(Number(group.slice(6))+i+1)&&m.trackId==='track-'+(Number(group.slice(6))+i)&&m.materialPreserved===true&&
   (m.groupTrackId===null||typeof m.groupTrackId==='string'&&trackId.test(m.groupTrackId)));
 if(!complete)return {...observed,bridgeReportedUngroupVerified:observed?.ungroupVerified,ungroupVerified:false,inspectionRequired:true,verificationError:'Incomplete native ungrouping receipt; inspect current tracks and retained handle'};
 return observed;
}
export async function getTrackUngroupingStatus(bridge,args){
 if(typeof args.ungroupingId!=='string'||!args.ungroupingId)throw Error('retained ungroupingId required');
 return checkedUngroupStatus(await bridge.request('get_track_ungrouping_status',{ungroupingId:args.ungroupingId}),args.ungroupingId);
}
export async function ungroupTracks(bridge,confirmations,host,args){
 if(typeof args.groupTrackId!=='string'||!trackId.test(args.groupTrackId))throw Error('one canonical Group track ID required');
 const read=()=>bridge.request('get_track_ungrouping_source',{groupTrackId:args.groupTrackId}),before=await read();
 if(before.stateVersion!==args.expectedStateVersion)throw Error('ungrouping state version changed');
 if(typeof args.expectedSetFingerprint!=='string'||before.setFingerprint!==args.expectedSetFingerprint)throw Error('ungrouping Set changed');
 if(before.operation!=='ungroup'||before.groupTrackId!==args.groupTrackId||typeof before.ungroupingId!=='string'||!before.ungroupingId||!before.filePath?.startsWith('/')||!before.setName||
  !Array.isArray(before.targets)||before.targets.length!==1||before.targets[0].trackId!==args.groupTrackId||before.targets[0].isGroup!==true||!Number.isInteger(before.targets[0].visibleIndex)||
  typeof before.hasGroupDevices!=='boolean'||!Array.isArray(before.removedGroup?.devices)||before.hasGroupDevices!==(before.removedGroup.devices.length>0)||
  !Array.isArray(before.visibleTracks)||!before.visibleTracks.length||before.visibleTracks.length>256||
  before.visibleTracks.some((t,i)=>typeof t.trackId!=='string'||!trackId.test(t.trackId)||typeof t.name!=='string'||typeof t.isGroup!=='boolean'||i>0&&Number(t.trackId.slice(6))<=Number(before.visibleTracks[i-1].trackId.slice(6)))||
  before.targets[0].visibleIndex<0||before.targets[0].visibleIndex>=before.visibleTracks.length||before.visibleTracks[before.targets[0].visibleIndex].trackId!==args.groupTrackId||
  before.visibleTracks[before.targets[0].visibleIndex].name!==before.targets[0].name||before.visibleTracks[before.targets[0].visibleIndex].isGroup!==true||
  !Array.isArray(before.members)||!before.members.length||before.members.length>255||
  before.members.some((m,i)=>m.sourceTrackId!=='track-'+(Number(args.groupTrackId.slice(6))+i+1)))throw Error('updated native ungrouping context required');
 const warning='Removes this Group and its entire processing/mixer stage. Child Group outputs become Main at root or feed the enclosing Group; custom child routes remain. Group effects, gain, pan, mute/solo, sends and its old output route are not transferred. Sound can change. IDs and numbered labels shift. Native selection/focus changes. Exposed descendants and controls are checked, not hidden plug-in state, complete automation or file bytes. No playback, saving, automatic undo or regrouping. Retain ungroupingId before confirming and never repeat an uncertain command.';
 const plan={method:'ungroup_tracks',groupTrackId:args.groupTrackId,allowContent:args.allowContent===true,expectedStateVersion:args.expectedStateVersion,before,warning};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(before.hasGroupDevices&&args.allowContent!==true)throw Error('Group devices require allowContent:true in a fresh reviewed plan');
 const hash=hashPlan(plan);if(args.planHash!==hash)throw Error('ungrouping context or content permission changed; review a fresh plan');confirmations.consume(args.confirmationToken,hash);
 const recheck=async(selection=false)=>{try{
  requestSignal()?.throwIfAborted();if(hashPlan(await read())!==hashPlan(before))throw Error('ungrouping context changed before native command');
  if(selection){const selected=await bridge.request('get_selection_context',{});if(selected.stateVersion!==before.stateVersion||selected.setFingerprint!==before.setFingerprint||selected.selectedTrack?.id!==args.groupTrackId)throw Error('native selected Group did not verify');}
 }catch(error){throw Object.assign(error,{groupRequested:false});}};
 let prepared,ui,error,cleanup,observed;
 try{prepared=await host.prepare(before,{beforePrepare:()=>recheck(),signal:requestSignal()});ui=await host.commit(before,prepared,{beforeCommit:()=>recheck(true),signal:requestSignal()});}
 catch(failure){error=failure;prepared=failure.prepared??prepared;if(prepared&&failure.groupRequested===false)try{cleanup=await host.cancel(before,prepared);}catch(failure){cleanup={cancelled:false,error:failure.message};}}
 try{observed=await getTrackUngroupingStatus(bridge,{ungroupingId:before.ungroupingId});}catch(failure){error??=failure;}
 const requested=error?error.groupRequested??ui?.groupRequested??null:ui?.groupRequested??null;
 const verified=!error&&ui?.groupRequested===true&&ui.popupClosed===true&&ui.uiIdle===true&&observed?.ungroupVerified===true&&observed.removedGroupId===args.groupTrackId&&observed.stateVersion===before.stateVersion+1&&
  observed.members.length===before.members.length&&observed.members.every((m,i)=>m.sourceTrackId===before.members[i].sourceTrackId);
 const publicUi=ui?{ungroupRequested:ui.groupRequested,popupClosed:ui.popupClosed,uiIdle:ui.uiIdle}:undefined;
 return {dryRun:false,requested:plan,ungroupingId:before.ungroupingId,ungroupRequested:requested,ungroupVerified:verified,observed:observed??null,ui:publicUi,dialogCleanup:cleanup,
  pendingUserAction:!verified&&(requested!==false||!!prepared&&cleanup?.cancelled!==true||error?.requiresInspection===true&&!prepared),
  ...(!verified?{verificationError:error?.message??observed?.verificationError??'Native ungrouping postconditions did not verify; inspect retained handle'}:{})};
}
