import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {MacLiveSetHost} from './live-set-host.mjs';

const identity=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs)});
export async function midiFileSource(path,{signal}={}){
 if(typeof path!=='string'||!isAbsolute(path)||! /\.(mid|smf)$/iu.test(path))throw Error('MIDI source must be an absolute .mid or .smf path');
 const entry=await lstat(path,{bigint:true});if(!entry.isFile()||entry.isSymbolicLink())throw Error('MIDI source must be a regular file, not a symlink');
 const canonical=await realpath(path),handle=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  signal?.throwIfAborted();const before=await handle.stat({bigint:true});if(before.size<14n||before.size>8388608n)throw Error('MIDI source must contain a header and be at most 8 MiB');
  const bytes=await handle.readFile({signal}),headerLength=bytes.readUInt32BE(4),format=bytes.readUInt16BE(8),tracks=bytes.readUInt16BE(10),division=bytes.readUInt16BE(12);
  if(bytes.toString('ascii',0,4)!=='MThd'||headerLength<6||headerLength>bytes.length-8||format>2||tracks<1||tracks>256||format===0&&tracks!==1||division===0)throw Error('unsupported MIDI source header');
  const info=identity(before);if(hashPlan(info)!==hashPlan(identity(await handle.stat({bigint:true})))||hashPlan(info)!==hashPlan(identity(await lstat(canonical,{bigint:true})))||await realpath(path)!==canonical)throw Error('MIDI source changed during inspection');
  return {path:canonical,...info,mtimeMs:Number(before.mtimeNs)/1e6,sha256:createHash('sha256').update(bytes).digest('hex'),format,tracks,timeDivision:division,
   scope:'Full file hash and SMF header only. Live validates/imports events; header inspection does not establish valid events or note/controller/tempo-map equivalence.'};
 }finally{await handle.close();}
}
const material=source=>{const copy=structuredClone(source);delete copy.stateVersion;return copy;};
export async function importMidiFile(bridge,confirmations,host,args){
 const params={trackId:args.trackId,clipId:args.clipId},read=()=>bridge.request('get_midi_import_target',params),before=await read();
 if(before.stateVersion!==args.expectedStateVersion||before.setFingerprint!==args.expectedSetFingerprint)throw Error('MIDI import Set or state changed');
 const file=await host.source(args.sourcePath,{signal:requestSignal()}),document=await host.context(before,{signal:requestSignal()}),plan={method:'import_midi_file',before,file,document,
  warning:'Selects the entire empty final MIDI staging track and Session slot, then imports the chosen local file through native Create > Import MIDI File. Multitrack files may add tracks/scenes with Live defaults. Changes selection/focus; does not save the Set. Binds native object structure and rechecks file identity/hash before Open, but not an atomic read by Live, note/controller/tempo-map contents or audible equivalence. Unknown imports are never replayed, undone or deleted.'};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('MIDI import confirmation context changed');confirmations.consume(args.confirmationToken,args.planHash);
 let working=before,selectionRequested=false,renderDispatched=false,ui,observed,error,fileAfter;
 const unchanged=async()=>{requestSignal()?.throwIfAborted();if(hashPlan(await read())!==hashPlan(working))throw Object.assign(Error('MIDI import target changed'),{importRequested:false});if(hashPlan(await host.source(args.sourcePath,{signal:requestSignal()}))!==hashPlan(file))throw Object.assign(Error('MIDI source file changed'),{importRequested:false});const selection=await bridge.request('get_selection_context',{});if(selection.selectedTrack?.id!==params.trackId||selection.highlightedClipSlot?.trackId!==params.trackId||selection.highlightedClipSlot?.clipId!==params.clipId||selection.highlightedClipSlot.hasClip!==false)throw Object.assign(Error('Native MIDI destination selection changed'),{importRequested:false});};
 try{
  selectionRequested=true;working=(await bridge.request('select_midi_import_target',{...params,before,expectedStateVersion:before.stateVersion})).source;
  if(hashPlan(material(working))!==hashPlan(material(before)))throw Object.assign(Error('MIDI import preparation changed its source context'),{importRequested:false});
  renderDispatched=true;ui=await host.render(working,file,document,{beforeOpenPicker:unchanged,beforeImport:unchanged,signal:requestSignal()});
 }catch(failure){error=failure;}
 try{observed=await bridge.request('inspect_midi_import',{identityToken:before.identityToken});}catch(failure){error??=failure;}
 try{fileAfter=await host.source(args.sourcePath,{signal:requestSignal()});}catch(failure){error??=failure;}
 const fileUnchanged=!!fileAfter&&hashPlan(fileAfter)===hashPlan(file),importRequested=error?error.importRequested??(renderDispatched?ui?.importRequested??null:false):ui.importRequested;
 const importVerified=!error&&importRequested===true&&ui.uiComplete===true&&fileUnchanged&&observed?.existingStructurePreserved===true&&observed.musicalUnchanged===true&&observed.recordingStopped===true&&observed.targetClips?.some(c=>c.id===params.clipId&&c.type==='midi')&&observed.trackEffect?.addedTracksInspected===true&&observed.trackEffect.addedTracks.every(t=>t.clipsInspected===true);
 return {dryRun:false,requested:plan,selectionRequested,importRequested,ui,observed:observed??null,fileUnchanged,importVerified:!!importVerified,
  pendingUserAction:!importVerified&&(error?.requiresInspection===true||importRequested!==false&&ui?.uiComplete!==true),
  completePerformanceEquivalenceVerified:false,audibleEquivalenceVerified:false,
  ...(!importVerified?{verificationError:error?.message??'Native import, file stability, target clip or existing structure did not verify'}:{}),
  limitation:'Verification covers the selected local file, an observed native MIDI clip, preserved object structure and unchanged tempo/meter. Existing note/parameter/envelope contents, file-event equivalence, full tempo maps and sound are not compared. Inspect additional tracks, defaults and partial state before playback or further edits.'};
}

const run=promisify(execFile),script=fileURLToPath(new URL('./live-midi-import.js',import.meta.url)),focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));
export class MacMidiImportHost{
 constructor({platform=process.platform,liveSetHost=new MacLiveSetHost(),execute=run,timeoutMs=10000}={}){Object.assign(this,{platform,liveSetHost,execute,timeoutMs});this.busy=false;}
 source(path,options){return midiFileSource(path,options);}
 async owner(source){if(this.platform!=='darwin')throw Error('Native MIDI file import requires macOS English Live');const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();if(processes.length!==1||processes[0].path!==executable)throw Error('Native MIDI import requires exactly one expected Live app');return {pid:processes[0].pid,appPath};}
 async call(owner,source,input,signal){const projected={filePath:source.filePath,trackUIPath:source.trackUIPath,clipId:source.clipId,sceneIndex:source.sceneIndex};const r=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({...owner,source:projected,...input})],{timeout:30000,maxBuffer:131072,signal})).stdout);if(r.error)throw Object.assign(Error(r.error),{importRequested:r.importRequested,requiresInspection:r.requiresInspection});return r;}
 async context(source,{signal}={}){return this.call(await this.owner(source),source,{action:'document'},signal);}
 async render(source,file,document,{beforeOpenPicker,beforeImport,signal}={}){
  if(this.busy)throw Object.assign(Error('Another native MIDI import is active'),{importRequested:false});this.busy=true;
  let owner,prepared,pickerDispatched=false,opened=false,importDispatched=false,importRequested=false;
  try{
   owner=await this.owner(source);if(hashPlan(await this.call(owner,source,{action:'document'},signal))!==hashPlan(document))throw Error('Native MIDI import document changed');
   const focus=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:document.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);if(!focus.focused)throw Error('Native MIDI import focus did not verify');
   const view=await this.call(owner,source,{action:'inspect'},signal);await beforeOpenPicker();pickerDispatched=true;
   const panel=await this.call(owner,source,{action:'openPicker',expected:view},signal);opened=true;
   prepared=await this.call(owner,source,{action:'prepare',windowId:panel.windowId,path:file.path},signal);
   if(!prepared.prepared||prepared.path!==file.path)throw Error('Native MIDI input selection did not verify');
   await beforeImport();if((await this.owner(source)).pid!==owner.pid)throw Error('Live process changed before MIDI import');
   importDispatched=true;const committed=await this.call(owner,source,{action:'commit',windowId:panel.windowId,path:file.path,file,document},signal);importRequested=committed.importRequested===true?true:null;
   if(importRequested!==true)return {importRequested,uiComplete:false};
   const deadline=Date.now()+this.timeoutMs;do{const state=await this.call(owner,source,{action:'finish',windowId:panel.windowId},signal);if(state.uiComplete){if(hashPlan(state.document)!==hashPlan(document))throw Error('Native MIDI import document changed after Open');return {importRequested:true,uiComplete:true};}await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
   return {importRequested:true,uiComplete:false};
  }catch(error){
   if(importDispatched){error.importRequested=importRequested===true?true:error.importRequested??null;error.requiresInspection=true;}
   else{error.importRequested=false;if(prepared?.prepared)try{const cleanup=await this.call(owner,source,{action:'cancel',windowId:prepared.windowId,path:prepared.path},undefined);error.requiresInspection=cleanup.cancelled!==true;}catch{error.requiresInspection=true;}else error.requiresInspection=opened||(error.requiresInspection??pickerDispatched);}
   throw error;
  }finally{this.busy=false;}
 }
}
