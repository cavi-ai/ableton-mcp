import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute,basename,extname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {parseMidi} from 'midi-file';
import {hashPlan} from './confirmation-store.mjs';
import {beginGuardedWrite} from './guarded-write.mjs';
import {requestSignal} from './request-context.mjs';
import {MacLiveSetHost} from './live-set-host.mjs';
import {pairMidiTrackNotes} from './midi-export.mjs';
import {matchMidiNoteReadback} from './scale-chord-progression.mjs';

const identity=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs)});
export async function midiFileSource(path,options){return (await readMidiFile(path,options)).source;}
async function readMidiFile(path,{signal}={}){
 if(typeof path!=='string'||!isAbsolute(path)||! /\.(mid|smf)$/iu.test(path))throw Error('MIDI source must be an absolute .mid or .smf path');
 const entry=await lstat(path,{bigint:true});if(!entry.isFile()||entry.isSymbolicLink())throw Error('MIDI source must be a regular file, not a symlink');
 const canonical=await realpath(path),handle=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  signal?.throwIfAborted();const before=await handle.stat({bigint:true});if(before.size<14n||before.size>8388608n)throw Error('MIDI source must contain a header and be at most 8 MiB');
  const bytes=await handle.readFile({signal}),headerLength=bytes.readUInt32BE(4),format=bytes.readUInt16BE(8),tracks=bytes.readUInt16BE(10),division=bytes.readUInt16BE(12);
  if(bytes.toString('ascii',0,4)!=='MThd'||headerLength<6||headerLength>bytes.length-8||format>2||tracks<1||tracks>256||format===0&&tracks!==1||division===0)throw Error('unsupported MIDI source header');
  const info=identity(before);if(hashPlan(info)!==hashPlan(identity(await handle.stat({bigint:true})))||hashPlan(info)!==hashPlan(identity(await lstat(canonical,{bigint:true})))||await realpath(path)!==canonical)throw Error('MIDI source changed during inspection');
  return {bytes,source:{path:canonical,...info,mtimeMs:Number(before.mtimeNs)/1e6,sha256:createHash('sha256').update(bytes).digest('hex'),format,tracks,timeDivision:division,
   scope:'Full file hash and SMF header only. Live validates/imports events; header inspection does not establish valid events or note/controller/tempo-map equivalence.'}};
 }finally{await handle.close();}
}

// The bridge writes notes only; any other channel event refuses the file instead of being dropped.
const nonNoteEvents=['noteAftertouch','controller','programChange','channelAftertouch','pitchBend','sysEx','endSysEx'];
const maxBridgeNotes=4096;
export function midiClipFromFile(bytes,path){
 let midi;try{midi=parseMidi(bytes);}catch(error){throw Error('MIDI file cannot be parsed: '+String(error.message??error));}
 const division=midi.header.ticksPerBeat;
 if(!Number.isInteger(division)||division<=0)throw Error('MIDI file uses SMPTE time; bridge import needs ticks per beat');
 let endTicks=0,meter=null;const noteTracks=[],other={};
 midi.tracks.forEach((events,index)=>{
  const paired=pairMidiTrackNotes(events,division);endTicks=Math.max(endTicks,paired.endTicks);
  if(paired.incomplete)throw Error(`MIDI track ${index} has a note without a note-off`);
  for(const type of nonNoteEvents)if(paired.eventCounts[type])other[type]=(other[type]??0)+paired.eventCounts[type];
  if(paired.notes.length)noteTracks.push({index,notes:paired.notes,name:events.find(e=>e.type==='trackName')?.text});
  let tick=0;for(const e of events){tick+=e.deltaTime;if(tick>0)break;if(!meter&&e.type==='timeSignature'&&Number.isInteger(e.numerator)&&e.numerator>0&&e.numerator<100&&[1,2,4,8,16,32].includes(e.denominator))meter={numerator:e.numerator,denominator:e.denominator};}
 });
 const found=Object.entries(other).map(([type,count])=>`${count} ${type}`);
 if(found.length)throw Error(`MIDI file has ${found.join(', ')} events; bridge import writes notes only`);
 if(!noteTracks.length)throw Error('MIDI file has no notes');
 if(noteTracks.length>1)throw Error(`MIDI file has notes in ${noteTracks.length} tracks; bridge import writes one clip`);
 const [track]=noteTracks,channels=[...new Set(track.notes.map(n=>n.channel))];
 if(channels.length>1)throw Error(`MIDI file has notes on ${channels.length} channels; bridge import writes one clip`);
 if(track.notes.length>maxBridgeNotes)throw Error(`MIDI file has ${track.notes.length} notes; bridge import writes at most ${maxBridgeNotes}`);
 if(track.notes.some(n=>n.duration<=0))throw Error('MIDI file has zero-length notes');
 const byPitch=[...track.notes].sort((a,b)=>a.pitch-b.pitch||a.start-b.start);
 for(let i=1;i<byPitch.length;i++)if(byPitch[i].pitch===byPitch[i-1].pitch&&byPitch[i].start<byPitch[i-1].start+byPitch[i-1].duration-1e-9)throw Error(`MIDI file has overlapping notes on pitch ${byPitch[i].pitch}`);
 const bar=meter?meter.numerator*4/meter.denominator:4,lastEnd=Math.max(...track.notes.map(n=>n.start+n.duration));
 const contentBeats=Math.max(endTicks/division,lastEnd),lengthBeats=Math.max(1,Math.ceil(contentBeats/bar-1e-9))*bar;
 const name=String(track.name??'').replace(/[\x00-\x1f\x7f]/gu,'').trim().slice(0,128)||basename(path,extname(path));
 const notes=track.notes.map(({pitch,start,duration,velocity})=>({pitch,start,duration,velocity,mute:false})).sort((a,b)=>a.start-b.start||a.pitch-b.pitch);
 return {name,lengthBeats,contentBeats,ticksPerBeat:division,meter:meter??{numerator:4,denominator:4,assumed:true},channel:channels[0],sourceTrack:track.index,noteCount:notes.length,notes};
}

// Reads the file and writes its notes into an empty Session slot through the bridge. Live's windows are never touched.
async function importThroughBridge(bridge,confirmations,args){
 const {trackId,clipId}=args,state=await bridge.request('get_live_state',{});
 if(state.stateVersion!==args.expectedStateVersion||state.setFingerprint!==args.expectedSetFingerprint)throw Error('MIDI import Set or state changed');
 const track=(await bridge.request('list_tracks',{})).tracks?.find(t=>t.id===trackId),clips=await bridge.request('list_clips',{trackId});
 if(!track)throw Error(`unknown track ${trackId}`);
 if(track.type!=='midi')throw Error('MIDI import target must be a MIDI track');
 if(clips.stateVersion!==args.expectedStateVersion)throw Error('MIDI import Set or state changed');
 if(clips.isFrozen)throw Error('MIDI import target track is frozen');
 const slot=clips.clips?.find(c=>c.id===clipId);
 if(!slot)throw Error(`unknown clip slot ${clipId}`);
 if(slot.hasClip)throw Error(`clip slot ${clipId} already contains a clip`);
 const {bytes,source}=await readMidiFile(args.sourcePath,{signal:requestSignal()}),clip=midiClipFromFile(bytes,source.path),{notes,...summary}=clip;
 const plan={method:'import_midi_file',route:'bridge',before:{stateVersion:state.stateVersion,setFingerprint:state.setFingerprint,filePath:state.filePath??null,trackId,trackName:track.name,clipId,slot},
  file:{...source,scope:'Full file hash. Notes are parsed here and written through the bridge.'},clip:summary,
  warning:'Writes the file\'s notes into the empty Session slot through the bridge. Live is not raised, focused or clicked; selection, tempo, meter and the saved Set are unchanged. Tempo, meter and track-name events in the file are not applied.'};
 const reply=beginGuardedWrite(confirmations,plan,args,{mismatch:'MIDI import confirmation context changed'});if(reply)return reply;
 const request={method:'create_midi_clip',trackId,clipId,expectedStateVersion:args.expectedStateVersion,lengthBeats:clip.lengthBeats,notes,name:clip.name};
 const result=fields=>({dryRun:false,route:'bridge',requested:plan,...fields,completePerformanceEquivalenceVerified:false,audibleEquivalenceVerified:false,
  limitation:'Verification covers the clip name, length and every note\'s pitch, start, duration and velocity read back from Live. Tempo, meter, instruments and sound are not compared.'});
 let created;
 try{created=await bridge.request('create_midi_clip',request);}
 catch(error){
  // A request the bridge never ran changed nothing; any other failure may have created a clip.
  if(error.outcome==='not_executed')throw error;
  return result({importRequested:null,importVerified:false,pendingUserAction:false,inspectionRequired:true,verificationError:String(error.message??error).slice(0,600)});
 }
 let readback,after,readError;
 try{readback=await bridge.request('get_midi_clip_notes',{trackId,clipId});after=(await bridge.request('list_clips',{trackId})).clips?.find(c=>c.id===clipId);}
 catch(error){readError=String(error.message??error).slice(0,600);}
 const notesMatch=!!readback&&matchMidiNoteReadback(notes,readback.notes.map(({pitch,start,duration,velocity,mute})=>({pitch,start,duration,velocity,mute})),1e-6);
 const importVerified=!readError&&created?.clip?.id===clipId&&created.clip.hasClip===true&&notesMatch&&Math.abs(readback.lengthBeats-clip.lengthBeats)<=1e-6&&after?.hasClip===true&&after.name===clip.name;
 return result({importRequested:true,stateVersion:created?.stateVersion,observed:{clip:created?.clip??null,name:after?.name??null,lengthBeats:readback?.lengthBeats??null,noteCount:readback?.notes?.length??null},
  importVerified,pendingUserAction:false,...(!importVerified?{inspectionRequired:true,verificationError:readError??'Created clip name, length or notes do not match the file'}:{})});
}

const material=source=>{const copy=structuredClone(source);delete copy.stateVersion;return copy;};
export async function importMidiFile(bridge,confirmations,host,args){
 if(args.route===undefined||args.route==='bridge')return importThroughBridge(bridge,confirmations,args);
 if(args.route!=='nativeDialog')throw Error('route must be bridge or nativeDialog');
 const params={trackId:args.trackId,clipId:args.clipId},read=()=>bridge.request('get_midi_import_target',params),before=await read();
 if(before.stateVersion!==args.expectedStateVersion||before.setFingerprint!==args.expectedSetFingerprint)throw Error('MIDI import Set or state changed');
 const file=await host.source(args.sourcePath,{signal:requestSignal()}),document=await host.context(before,{signal:requestSignal()}),plan={method:'import_midi_file',route:'nativeDialog',before,file,document,
  warning:'Selects the entire empty final MIDI staging track and Session slot, then imports the chosen local file through native Create > Import MIDI File. Multitrack files may add tracks/scenes with Live defaults. Changes selection/focus; does not save the Set. Binds native object structure and rechecks file identity/hash before Open, but not an atomic read by Live, note/controller/tempo-map contents or audible equivalence. Unknown imports are never replayed, undone or deleted.'};
 const reply=beginGuardedWrite(confirmations,plan,args,{mismatch:'MIDI import confirmation context changed'});if(reply)return reply;
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
  ...(typeof error?.pickerCancelled==='boolean'?{pickerCancelled:error.pickerCancelled}:{}),
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
  let owner,panel,pickerDispatched=false,importDispatched=false,importRequested=false;
  try{
   owner=await this.owner(source);if(hashPlan(await this.call(owner,source,{action:'document'},signal))!==hashPlan(document))throw Error('Native MIDI import document changed');
   const focus=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:document.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);if(!focus.focused)throw Error('Live window is not on screen; the native picker route never moves Live or switches desktops, so nothing was opened. The bridge route needs no window');
   const view=await this.call(owner,source,{action:'inspect'},signal);await beforeOpenPicker();pickerDispatched=true;
   panel=await this.call(owner,source,{action:'openPicker',expected:view},signal);
   const prepared=await this.call(owner,source,{action:'prepare',windowId:panel.windowId,path:file.path},signal);
   if(!prepared.prepared||prepared.path!==file.path)throw Error('Native MIDI input selection did not verify');
   await beforeImport();if((await this.owner(source)).pid!==owner.pid)throw Error('Live process changed before MIDI import');
   importDispatched=true;const committed=await this.call(owner,source,{action:'commit',windowId:panel.windowId,path:file.path,file,document},signal);importRequested=committed.importRequested===true?true:null;
   if(importRequested!==true)return {importRequested,uiComplete:false};
   const deadline=Date.now()+this.timeoutMs;do{const state=await this.call(owner,source,{action:'finish',windowId:panel.windowId},signal);if(state.uiComplete){if(hashPlan(state.document)!==hashPlan(document))throw Error('Native MIDI import document changed after Open');return {importRequested:true,uiComplete:true};}await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
   return {importRequested:true,uiComplete:false};
  }catch(error){
   if(importDispatched){error.importRequested=importRequested===true?true:error.importRequested??null;error.requiresInspection=true;}
   else{
    error.importRequested=false;
    // After the menu press, every failure before Open closes the picker. A lost picker reply has no window id; the cancel then takes the only import picker.
    if(pickerDispatched)try{const cleanup=await this.call(owner,source,{action:'cancel',windowId:panel?.windowId??null},undefined);error.pickerCancelled=cleanup.cancelled===true;error.requiresInspection=cleanup.cancelled!==true;}catch{error.pickerCancelled=false;error.requiresInspection=true;}
    else error.requiresInspection=false;
   }
   throw error;
  }finally{this.busy=false;}
 }
}
