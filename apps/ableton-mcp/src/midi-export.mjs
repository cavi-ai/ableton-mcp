import {parseMidi} from 'midi-file';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';

const maxBytes=8*1024*1024;
export function inspectMidiBytes(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<26||bytes.length>maxBytes||bytes.toString('ascii',0,4)!=='MThd'||bytes.readUInt32BE(4)!==6)throw Error('unsupported or incomplete MIDI header');
  const format=bytes.readUInt16BE(8),tracks=bytes.readUInt16BE(10),division=bytes.readUInt16BE(12);
  if(format!==0||tracks!==1||!division||division&0x8000)throw Error('native MIDI verification requires SMF0 with a positive beat division');
  if(bytes.toString('ascii',14,18)!=='MTrk'||bytes.readUInt32BE(18)!==bytes.length-22)throw Error('MIDI track coverage is incomplete or has trailing bytes');
  let midi;try{midi=parseMidi(bytes);}catch(error){throw Error('MIDI event parsing failed: '+String(error.message??error));}
  const events=midi.tracks[0];if(events.length>1000000||events.at(-1)?.type!=='endOfTrack'||events.filter(e=>e.type==='endOfTrack').length!==1)throw Error('MIDI track must have one final end marker');
  let tick=0,unmatchedNoteOffs=0;const active=new Map(),notes=[],eventCounts={};
  for(const e of events){
    if(!Number.isSafeInteger(e.deltaTime)||e.deltaTime<0||!Number.isSafeInteger(tick+=e.deltaTime))throw Error('MIDI event time is invalid');
    eventCounts[e.type]=(eventCounts[e.type]??0)+1;
    if(!['noteOn','noteOff'].includes(e.type))continue;
    if(!Number.isInteger(e.channel)||e.channel<0||e.channel>15||!Number.isInteger(e.noteNumber)||e.noteNumber<0||e.noteNumber>127||!Number.isInteger(e.velocity)||e.velocity<0||e.velocity>127)throw Error('MIDI note data is invalid');
    const key=e.channel+':'+e.noteNumber,queue=active.get(key)??[];
    if(e.type==='noteOn'&&e.velocity>0){queue.push({channel:e.channel,pitch:e.noteNumber,startTick:tick,velocity:e.velocity});active.set(key,queue);}
    else{const start=queue.shift();if(!start){unmatchedNoteOffs++;continue;}notes.push({channel:start.channel,pitch:start.pitch,start:start.startTick/division,duration:(tick-start.startTick)/division,velocity:start.velocity,releaseVelocity:e.velocity});}
  }
  if([...active.values()].some(q=>q.length))throw Error('MIDI export contains incomplete note durations');
  notes.sort((a,b)=>a.start-b.start||a.pitch-b.pitch||a.channel-b.channel||a.duration-b.duration);
  return {format,ticksPerBeat:division,endBeats:tick/division,notes,eventCounts,unmatchedNoteOffs,
    limitation:'SMF structure and stored MIDI events only; channel/pitch pairing cannot recover Live note identities, hidden expression, random behavior, instruments or audible equivalence.'};
}

const identity=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs)});
export async function verifyMidiArtifact(path,{signal}={}){
  const entry=await lstat(path,{bigint:true});if(!entry.isFile()||entry.isSymbolicLink())throw Error('MIDI artifact must be a regular file, not a symlink');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    signal?.throwIfAborted();const before=await handle.stat({bigint:true});
    if(!before.isFile()||before.size<=0n||before.size>BigInt(maxBytes))throw Error('MIDI artifact must be nonempty and at most 8 MiB');
    const bytes=await handle.readFile({signal}),details=inspectMidiBytes(bytes),expected=identity(before);
    if(JSON.stringify(expected)!==JSON.stringify(identity(await handle.stat({bigint:true})))||JSON.stringify(expected)!==JSON.stringify(identity(await lstat(path,{bigint:true}))))throw Error('MIDI file changed during verification');
    return {verified:true,path,...expected,sha256:createHash('sha256').update(bytes).digest('hex'),...details};
  }finally{await handle.close();}
}

import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';

export function compareMidiNotes(artifact,source){
  const expected=source.notes.filter(n=>!n.mute),available=artifact.notes.map((n,i)=>({...n,index:i})),used=new Set(),tolerance=1/artifact.ticksPerBeat+1e-8;
  let matched=expected.length===available.length,releaseVelocityMatch=true;
  if(matched)for(const note of expected){
    const candidates=available.filter(n=>!used.has(n.index)&&n.pitch===note.pitch&&n.velocity===note.velocity&&Math.abs(n.start-note.start)<=tolerance&&Math.abs(n.start+n.duration-note.start-note.duration)<=tolerance);
    candidates.sort((a,b)=>(Math.abs(a.start-note.start)+Math.abs(a.duration-note.duration))-(Math.abs(b.start-note.start)+Math.abs(b.duration-note.duration)));
    const actual=candidates[0];if(!actual){matched=false;break;}used.add(actual.index);releaseVelocityMatch&&=actual.releaseVelocity===note.releaseVelocity;
  }
  return {pitchTimingVelocityMatch:matched,releaseVelocityMatch:matched&&releaseVelocityMatch,sourceUnmutedNotes:expected.length,fileNotes:available.length,
    omittedMutedNotes:source.notes.length-expected.length,timingToleranceBeats:tolerance,
    scope:'All unmuted stored notes, including notes outside loop/playback markers. MIDI channel-to-Live-note identity, loop state, probability, velocity deviation, grooves, MPE and controller equivalence are not verified.'};
}
const material=source=>{const copy=structuredClone(source);delete copy.stateVersion;if(copy.timing)delete copy.timing.stateVersion;return copy;};
export async function saveMidiClip(bridge,confirmations,host,args){
  const params={trackId:args.trackId,clipId:args.clipId},read=()=>bridge.request('get_midi_export_source',params),before=await read();
  if(before.stateVersion!==args.expectedStateVersion)throw Error('MIDI export source state changed');
  const destination=await host.destination(args.path,before,{signal:requestSignal()}),plan={method:'export_midi_clip',before,destination,
    warning:'Selects the exact clip and changes focus, then uses native Export MIDI Clip to create a new .mid file. Refuses overwrites. Native export can include notes outside loop/playback markers and omit muted notes; Live currently quantizes exported timing to 96 ticks per beat. Does not render MIDI effects or instruments, save the Set, preserve Live loop/probability/velocity-deviation controls or prove MPE/controller/audible equivalence. Unknown saves are never replayed, undone or deleted.'};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('MIDI export confirmation context changed');confirmations.consume(args.confirmationToken,args.planHash);
  let working=before,selectionRequested=false,renderDispatched=false,ui,artifact,after,error;
  const unchanged=async expected=>{try{requestSignal()?.throwIfAborted();if(hashPlan(await read())!==hashPlan(expected))throw Error('MIDI export source changed');if(host.recheckDestination)await host.recheckDestination(destination,{signal:requestSignal()});else if(hashPlan(await host.destination(args.path,expected,{signal:requestSignal()}))!==hashPlan(destination))throw Error('MIDI export destination changed');}catch(failure){failure.saveRequested=false;throw failure;}};
  const selected=async()=>{const s=await bridge.request('get_selection_context',{});if(s.selectedTrack?.id!==params.trackId||s.detailClip?.trackId!==params.trackId||s.detailClip.clipId!==params.clipId)throw Object.assign(Error('selected MIDI export clip changed'),{saveRequested:false});};
  try{
    await unchanged(before);selectionRequested=true;
    working=(await bridge.request('select_midi_export_source',{...params,before,expectedStateVersion:before.stateVersion})).source;
    if(hashPlan(material(working))!==hashPlan(material(before)))throw Object.assign(Error('selected MIDI export source did not verify'),{saveRequested:false});
    renderDispatched=true;ui=await host.render(working,destination,{beforeExport:async()=>{await unchanged(working);await selected();},beforeSave:async()=>{await unchanged(working);await selected();},signal:requestSignal()});
    if(ui.saveRequested===true&&ui.uiComplete===true)artifact=await host.verify(destination,working,{signal:requestSignal()});
  }catch(failure){error=failure;}
  try{after=await read();}catch(failure){error??=failure;}
  const sourcePreserved=!!after&&after.stateVersion===working?.stateVersion&&hashPlan(material(after))===hashPlan(material(before)),noteComparison=artifact?.verified?compareMidiNotes(artifact,before):null;
  const saveRequested=error?error.saveRequested??(renderDispatched?ui?.saveRequested??null:false):ui.saveRequested;
  const exportVerified=!error&&saveRequested===true&&ui.uiComplete===true&&artifact?.verified===true&&sourcePreserved&&noteComparison.pitchTimingVelocityMatch;
  return {dryRun:false,requested:plan,observed:after??null,selectionRequested,saveRequested,ui,artifact:artifact??null,artifactVerified:artifact?.verified===true,sourcePreserved,noteComparison,exportVerified,
    pendingUserAction:!exportVerified&&(error?.requiresInspection===true||saveRequested!==false&&ui?.uiComplete!==true),
    completePerformanceEquivalenceVerified:false,audibleEquivalenceVerified:false,
    ...(!exportVerified?{verificationError:error?.message??'MIDI file, source preservation or exposed note comparison did not verify'}:{}),
    limitation:'Verification covers a new SMF0 artifact and unmuted note pitch/timing/velocity within its beat resolution, not hidden expression, controllers, channels, Live playback behavior, sounds or a saved Set. Preserve uncertain files and inspect before further input.'};
}

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {isAbsolute,dirname,basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MacLiveSetHost} from './live-set-host.mjs';
const run=promisify(execFile),nativeScript=fileURLToPath(new URL('./live-midi-export.js',import.meta.url)),saveScript=fileURLToPath(new URL('./live-set-save-dialog.js',import.meta.url)),focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));
export class MacMidiExportHost{
  constructor({platform=process.platform,liveSetHost=new MacLiveSetHost(),execute=run,timeoutMs=10000}={}){this.platform=platform;this.liveSetHost=liveSetHost;this.execute=execute;this.timeoutMs=timeoutMs;this.busy=false;}
  async owner(source){if(this.platform!=='darwin')throw Error('native MIDI export requires macOS English Live');const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();if(processes.length!==1||processes[0].path!==executable)throw Error('native MIDI export requires exactly one expected Live app');return {pid:processes[0].pid,appPath};}
  async call(script,input,signal){if(script===nativeScript&&input.source){const s=input.source;input={...input,source:{filePath:s.filePath,name:s.name,trackUIPath:s.trackUIPath,location:s.location,clipId:s.clipId}};}const r=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify(input)],{timeout:30000,maxBuffer:131072,signal})).stdout);if(r.error)throw Object.assign(Error(r.error),{saveRequested:r.saveRequested,requiresInspection:r.requiresInspection,recovery:r.recovery});return r;}
  async reserve(path){
    if(typeof path!=='string'||!isAbsolute(path)||!path.endsWith('.mid'))throw Error('MIDI destination must be an absolute new .mid path');const name=basename(path);if(name.startsWith('.')||name.length>128||name!==name.trim()||/[:\x00-\x1f\x7f]/u.test(name))throw Error('MIDI filename must be visible and contain no colons or control characters');
    const parent=await realpath(dirname(path)),info=await lstat(parent,{bigint:true});if(!info.isDirectory())throw Error('MIDI export parent must already be a directory');const canonical=join(parent,name);
    try{await lstat(canonical);throw Error('MIDI export destination already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
    return {path:canonical,name,parent:{path:parent,dev:String(info.dev),ino:String(info.ino)}};
  }
  async destination(path,source,{signal}={}){const reservation=await this.reserve(path),owner=await this.owner(source),document=await this.call(nativeScript,{...owner,source,action:'document'},signal);return {...reservation,document};}
  async recheckDestination(expected){const {document,...reservation}=expected;if(hashPlan(await this.reserve(expected.path))!==hashPlan(reservation))throw Error('MIDI export destination directory changed');}
  async render(source,destination,{beforeExport,beforeSave,signal}={}){
    if(this.busy)throw Object.assign(Error('another MIDI export is active'),{saveRequested:false});this.busy=true;
    let owner,prepared,preparationDispatched=false,openedPanel=false,saveDispatched=false,saveRequested=false;
    try{
      owner=await this.owner(source);const document=await this.call(nativeScript,{...owner,source,action:'document'},signal);
      if(hashPlan(document)!==hashPlan(destination.document))throw Object.assign(Error('MIDI export Set window changed'),{saveRequested:false});
      const focus=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:document.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);if(!focus.focused)throw Object.assign(Error('Live focus did not verify'),{saveRequested:false});
      const view=await this.call(nativeScript,{...owner,source,action:'inspect'},signal);await beforeExport();
      preparationDispatched=true;const opened=await this.call(nativeScript,{...owner,source,action:'open',expected:view},signal);openedPanel=true;
      prepared=await this.call(saveScript,{...owner,action:'adoptMidiExport',windowId:opened.saveWindowId,parent:destination.parent.path},signal);
      if(!prepared.prepared||prepared.purpose!=='Save MIDI Clip As:')throw Error('Owned native MIDI Save panel did not verify');
      await beforeSave();const current=await this.owner(source);if(current.pid!==owner.pid)throw Object.assign(Error('Live process changed before MIDI Save'),{saveRequested:false});
      saveDispatched=true;const saved=await this.call(saveScript,{...owner,...prepared,action:'commit',parent:destination.parent.path,name:destination.name,parentIdentity:destination.parent},signal);saveRequested=saved.savePressed===true?true:null;
      if(saveRequested!==true)return {saveRequested,uiComplete:false};
      const deadline=Date.now()+this.timeoutMs;let complete=false;
      do{const state=await this.call(nativeScript,{...owner,source,action:'finish',saveWindowId:opened.saveWindowId},signal);complete=state.uiComplete===true;if(complete){if(hashPlan(state.document)!==hashPlan(destination.document))throw Error('MIDI export document changed after Save');try{await lstat(destination.path);return {saveRequested:true,uiComplete:true};}catch(error){if(error.code!=='ENOENT')throw error;}}await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
      return {saveRequested:true,uiComplete:complete,fileAwaitingInspection:true};
    }catch(error){
      if(saveDispatched){error.saveRequested=saveRequested===true?true:error.saveRequested??null;error.requiresInspection=true;}
      else{error.saveRequested=false;if(prepared?.prepared)try{const cleanup=await this.call(saveScript,{...owner,...prepared,action:'cancel'},undefined);error.requiresInspection=cleanup.cancelled!==true;}catch{error.requiresInspection=true;}else error.requiresInspection=openedPanel||(error.requiresInspection??preparationDispatched);}
      throw error;
    }finally{this.busy=false;}
  }
  async verify(destination,source,{signal}={}){const current=await lstat(destination.parent.path,{bigint:true});if(await realpath(destination.parent.path)!==destination.parent.path||String(current.dev)!==destination.parent.dev||String(current.ino)!==destination.parent.ino)throw Error('MIDI export directory changed after Save');return verifyMidiArtifact(destination.path,{signal});}
}
