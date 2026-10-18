import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MacLiveSetHost} from './live-set-host.mjs';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
const run=promisify(execFile),maxBytes=64*1024*1024;
const script=fileURLToPath(new URL('./live-audio-reverse.js',import.meta.url));
const focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));
const identity=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)});
const material=x=>Array.isArray(x)?x.map(material):x&&typeof x==='object'
 ?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='stateVersion').map(([k,v])=>[k,material(v)])):x;

export function compareReversedPcm(source,after,channels){
 if(!Number.isInteger(channels)||channels<1||channels>8||!source.length||source.length!==after.length||source.length%(channels*4))throw Error('reversed audio frame layout differs');
 const frames=source.length/(channels*4);let maxAbsoluteError=0;
 for(let f=0;f<frames;f++)for(let c=0;c<channels;c++){
  const a=source.readFloatLE(((frames-1-f)*channels+c)*4),b=after.readFloatLE((f*channels+c)*4);
  if(!Number.isFinite(a)||!Number.isFinite(b))throw Error('nonfinite decoded audio sample');
  maxAbsoluteError=Math.max(maxAbsoluteError,Math.abs(a-b));
 }
 return {matched:maxAbsoluteError<=2e-6,frames,channels,maxAbsoluteError,tolerance:2e-6};
}

export async function readBoundedAudioBytes(handle,entry,{signal}={}){
 const before=await handle.stat({bigint:true});
 if(!before.isFile()||before.size<=0n||before.size>BigInt(maxBytes))throw Error('opened reversal source exceeds regular file / 64 MiB bounds');
 if(hashPlan(identity(before))!==hashPlan(identity(entry)))throw Error('reversal source identity changed before open');
 const bytes=Buffer.alloc(Number(before.size));let position=0;
 while(position<bytes.length){signal?.throwIfAborted();const r=await handle.read(bytes,position,Math.min(65536,bytes.length-position),position);if(!r.bytesRead)throw Error('reversal source truncated during read');position+=r.bytesRead;}
 if((await handle.read(Buffer.alloc(1),0,1,position)).bytesRead)throw Error('reversal source grew during bounded read');
 return {bytes,before};
}

export async function readReversalAudio(path,{signal,execute=run}={}){
 const deadline=AbortSignal.timeout(30000);signal=signal?AbortSignal.any([signal,deadline]):deadline;
 if(typeof path!=='string'||!isAbsolute(path))throw Error('reversal requires an absolute local audio source');
 const entry=await lstat(path,{bigint:true});if(!entry.isFile()||entry.isSymbolicLink()||entry.size<=0n||entry.size>BigInt(maxBytes))throw Error('reversal source must be a regular nonsymlink file of at most 64 MiB');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const {before,bytes}=await readBoundedAudioBytes(handle,entry,{signal}),expected=identity(before);
  const metadata=JSON.parse((await execute('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-select_streams','a:0','-show_streams','-show_format','-of','json',path],{timeout:10000,maxBuffer:65536,signal})).stdout);
  const stream=metadata.streams?.[0],sampleRate=Number(stream?.sample_rate),channels=Number(stream?.channels),duration=Number(metadata.format?.duration);
  if(!stream||!(/^(?:pcm_|flac$)/.test(stream.codec_name))||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000||!Number.isInteger(channels)||channels<1||channels>8||!Number.isFinite(duration)||duration<=0||duration>60)throw Error('reversal verification supports PCM/FLAC sources up to 60 seconds, 8 channels and 192 kHz');
  const pcm=(await execute('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',path,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'],{timeout:30000,maxBuffer:maxBytes,encoding:'buffer',signal})).stdout;
  const frames=pcm.length/(channels*4);if(!Number.isInteger(frames)||frames<=0||frames/sampleRate>60)throw Error('decoded reversal source exceeds supported frame bounds');
  if(hashPlan(expected)!==hashPlan(identity(await handle.stat({bigint:true})))||hashPlan(expected)!==hashPlan(identity(await lstat(path,{bigint:true}))))throw Error('reversal source changed during inspection');
  return {artifact:{path,...expected,sha256:createHash('sha256').update(bytes).digest('hex'),sampleRate,channels,frames,durationSeconds:frames/sampleRate,codec:stream.codec_name},pcm};
 }finally{await handle.close();}
}

export async function reverseAudioClip(bridge,confirmations,host,args){
 const ids={trackId:args.trackId,clipId:args.clipId},read=()=>bridge.request('get_audio_clip_reverse_source',ids),before=await read();
 if(before.stateVersion!==args.expectedStateVersion||before.trackId!==ids.trackId||before.clipId!==ids.clipId||typeof before.ownerIdentityToken!=='string'||!before.ownerIdentityToken)throw Error('audio reversal source identity or version changed');
 const native=await host.context(before,{signal:requestSignal()}),plan={method:'reverse_audio_clip',...ids,expectedStateVersion:args.expectedStateVersion,before,native,
  warning:'Selects this exact clip and presses native Reverse once. Reverses its whole source, with Live changing loop/region and warp placement while envelopes remain at their clip times. Changes focus and source reference; no rollback or retry. The source file is preserved. Verification covers bounded decoded source audio, not complete envelope contents, audible outcome or saved media. Duplicate first to preserve the original clip.'};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('audio reversal confirmation context changed');confirmations.consume(args.confirmationToken,args.planHash);
 let working=before,selectionRequested=false,reverseRequested=false,ui,after,verification,error;
 const recheck=async()=>{
  requestSignal()?.throwIfAborted();
  await host.recheck(native,{signal:requestSignal()});
  if(hashPlan(await read())!==hashPlan(working))throw Error('audio reversal source changed before Reverse');
  const selection=await bridge.request('get_selection_context',{});
  if(selection.setFingerprint!==before.setFingerprint||selection.selectedTrack?.id!==ids.trackId||selection.detailClip?.trackId!==ids.trackId||selection.detailClip?.clipId!==ids.clipId)throw Error('selected audio reversal target changed');
 };
 try{
  selectionRequested=true;
  const selected=await bridge.request('select_audio_clip_reverse_source',{...ids,before,expectedStateVersion:before.stateVersion});
  working=selected.source;
  if(selected.stateVersion!==before.stateVersion+1||hashPlan(material(working))!==hashPlan(material(before)))throw Error('native audio reversal selection did not verify');
  ui=await host.reverse(working,native,{beforePress:recheck,signal:requestSignal()});reverseRequested=ui.reverseRequested;
  if(reverseRequested!==true)throw Error('native Reverse request is unconfirmed');
  const deadline=Date.now()+15000;
  do{
   after=await read();
   if(after.audio.source.path!==before.audio.source.path)break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }while(Date.now()<deadline);
  if(after.audio.source.path===before.audio.source.path)throw Error('native reversed source reference is unconfirmed');
  verification=await host.verify(native.sourceArtifact,after.audio.source.path,{signal:requestSignal()});
  if(hashPlan(await read())!==hashPlan(after))throw Error('reversed clip changed during audio verification');
 }catch(failure){error=failure;if(failure.reverseRequested!==undefined)reverseRequested=failure.reverseRequested;}
 if(!after)try{after=await read();}catch(failure){error??=failure;}
 const controls=s=>({name:s.name,muted:s.muted,hasEnvelopes:s.hasEnvelopes,gain:s.audio.gain,pitch:s.audio.pitch,warping:s.audio.warping,warpMode:s.audio.warpMode,fades:s.audio.fades});
 const clipIdentityPreserved=!!after&&after.identityToken===before.identityToken&&after.setFingerprint===before.setFingerprint;
 const clipTargetVerified=!!after&&after.ownerIdentityToken===before.ownerIdentityToken&&after.setFingerprint===before.setFingerprint&&after.trackId===ids.trackId&&after.clipId===ids.clipId;
 const clipControlsPreserved=!!after&&hashPlan(controls(after))===hashPlan(controls(before));
 const reverseVerified=!error&&reverseRequested===true&&clipTargetVerified&&clipControlsPreserved&&verification?.sourceBytesPreserved===true&&verification?.contentReversalVerified===true;
 return {dryRun:false,requested:plan,selectionRequested,reverseRequested,ui,observed:after??null,verification:verification??null,
  clipIdentityPreserved,clipTargetVerified,clipControlsPreserved,reverseVerified,timingTransformationVerified:false,audibleOutcomeVerified:false,
  ...(!reverseVerified?{verificationError:error?.message??'audio reversal postconditions did not verify'}:{}),
  limitation:'Native whole-source reversal and measured decoded samples only. Inspect changed loop/region/warp state and listen; envelope contents, playback equivalence and saved project media are not verified. Partial work remains without rollback or replay.'};
}

export class MacAudioReverseHost{
 constructor({platform=process.platform,liveSetHost=new MacLiveSetHost(),execute=run}={}){this.platform=platform;this.liveSetHost=liveSetHost;this.execute=execute;this.busy=false;}
 async owner(source){
  if(this.platform!=='darwin'||!isAbsolute(source.filePath||''))throw Error('native audio reversal requires a saved Set and macOS English Live');
  const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();
  if(processes.length!==1||processes[0].path!==executable)throw Error('native audio reversal requires one exact Live process');
  return {pid:processes[0].pid,appPath};
 }
 async call(owner,source,action,extra={},signal){
  const target={filePath:source.filePath,name:source.name,trackUIPath:source.trackUIPath,location:source.location};
  const r=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({...owner,source:target,action,...extra})],{timeout:10000,maxBuffer:65536,signal})).stdout);
  if(r.error)throw Object.assign(Error(r.error),{reverseRequested:r.reverseRequested});return r;
 }
 async context(source,{signal}={}){
  const owner=await this.owner(source),document=await this.call(owner,source,'document',{},signal),{artifact}=await readReversalAudio(source.audio.source.path,{signal,execute:this.execute});
  return {...owner,document,sourceArtifact:artifact};
 }
 async recheck(native,{signal}={}){
  const {artifact}=await readReversalAudio(native.sourceArtifact.path,{signal,execute:this.execute});
  if(hashPlan(artifact)!==hashPlan(native.sourceArtifact))throw Error('original audio source bytes or identity changed');
 }
 async reverse(source,native,{beforePress,signal}={}){
  if(this.busy)throw Object.assign(Error('another native audio reversal is active'),{reverseRequested:false});this.busy=true;
  let dispatched=false;
  try{
   const owner=await this.owner(source),document=await this.call(owner,source,'document',{},signal);
   if(hashPlan(owner)!==hashPlan({pid:native.pid,appPath:native.appPath})||hashPlan(document)!==hashPlan(native.document))throw Error('audio reversal Live process or document changed');
   const focus=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:document.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);
   if(focus.focused!==true)throw Error('audio reversal focus did not verify');
   const expected=await this.call(owner,source,'inspect',{},signal);await beforePress();signal?.throwIfAborted();
   dispatched=true;return await this.call(owner,source,'commit',{expected},signal);
  }catch(error){error.reverseRequested??=dispatched?null:false;throw error;}finally{this.busy=false;}
 }
 async verify(expected,path,{signal}={}){
  const source=await readReversalAudio(expected.path,{signal,execute:this.execute});
  if(hashPlan(source.artifact)!==hashPlan(expected))throw Error('original audio source changed during reversal');
  const after=await readReversalAudio(path,{signal,execute:this.execute});
  if(after.artifact.channels!==expected.channels||after.artifact.sampleRate!==expected.sampleRate)throw Error('reversed audio sample rate or channel layout differs');
  const comparison=compareReversedPcm(source.pcm,after.pcm,expected.channels);
  return {sourceBytesPreserved:true,contentReversalVerified:comparison.matched,source:source.artifact,reversed:after.artifact,comparison};
 }
}
