import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {realpath,lstat,mkdtemp,readdir,link,unlink,rmdir} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import {isAbsolute,dirname,basename,join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as pause} from "node:timers/promises";
import {hashPlan} from "./confirmation-store.mjs";
import {requestSignal} from "./request-context.mjs";
import {MacLiveSetHost} from "./live-set-host.mjs";

const run=promisify(execFile);
const exportScript=fileURLToPath(new URL("./live-audio-export-dialog.js",import.meta.url));
const saveScript=fileURLToPath(new URL("./live-set-save-dialog.js",import.meta.url));
const focusScript=fileURLToPath(new URL("./live-app-focus.js",import.meta.url));

export function exportSettings(args){
  const coordinate=(value,start)=>{
    if(typeof value!=="string"||!/^\d{1,6}\.\d{1,3}\.\d{1,3}$/u.test(value))throw Error("export range must use native bars.beats.sixteenths coordinates");
    const parts=value.split(".").map(Number);
    if(parts[0]<(start?1:0)||parts[1]<(start?1:0)||parts[2]<(start?1:0)||(!start&&parts.every(n=>n===0)))throw Error("export range must have a positive start and length");
    return parts;
  };
  const sampleRate=args.sampleRate??48000,bitDepth=args.bitDepth??24;
  if(![44100,48000,88200,96000].includes(sampleRate)||![16,24,32].includes(bitDepth))throw Error("unsupported export sample rate or bit depth");
  return {start:coordinate(args.start,true),length:coordinate(args.length,false),sampleRate,bitDepth};
}

export function exportAudioMix(bridge,confirmations,host,args){
  return exportAudio(bridge,confirmations,host,args,false);
}

export function exportAudioTrack(bridge,confirmations,host,args){
  return exportAudio(bridge,confirmations,host,args,true);
}

function renderTarget(before,trackId){
  const targets=before.renderTargets;
  if(!Array.isArray(targets)||targets.length>512||!targets.length)throw Error('updated bridge audio output inventory required');
  const ids=new Set();
  for(const target of targets){
    if(!target||typeof target.trackId!=='string'||!/^(track|return)-(0|[1-9]\d*)$/u.test(target.trackId)||
       ids.has(target.trackId)||typeof target.name!=='string'||!target.name||typeof target.hasAudioOutput!=='boolean')
      throw Error('duplicate, unknown or invalid audio output inventory');
    ids.add(target.trackId);
  }
  const eligible=targets.filter(t=>t.hasAudioOutput),index=eligible.findIndex(t=>t.trackId===trackId);
  if(index<0)throw Error('target must be an observed track or Return with audio output; use export_audio_mix for Main');
  return {trackId,name:eligible[index].name,menuIndex:index+3,
    menuTitles:['Main','All Individual Tracks','Selected Tracks Only',...eligible.map(t=>t.name)]};
}

async function exportAudio(bridge,confirmations,host,args,trackMode){
  if(!Number.isInteger(args.expectedStateVersion))throw Error("expectedStateVersion is required");
  if(trackMode&&args.includeReturnMainEffects!==undefined&&typeof args.includeReturnMainEffects!=='boolean')throw Error('includeReturnMainEffects must be boolean');
  const readSource=async()=>{
    for(let attempt=0;;attempt++){
      try{return await bridge.request("get_audio_export_source",{});}
      catch(error){
        if(attempt>=2||error.code!=="BRIDGE_TRANSPORT"||error.outcome!=="not_executed")throw error;
        // Only retry an untransmitted read. Native Export and Save are never replayed.
        await pause(150,undefined,{signal:requestSignal()});
      }
    }
  };
  const settings=exportSettings(args),before=await readSource();
  if(!before.identityToken)throw Error("updated bridge audio export context required");
  if(before.stateVersion!==args.expectedStateVersion||before.setFingerprint!==args.expectedSetFingerprint)throw Error("audio export document or state version changed");
  if(trackMode){settings.renderTarget=renderTarget(before,args.trackId);settings.includeReturnMainEffects=args.includeReturnMainEffects??false;}
  const appPath=host.appPathFor(before),destination=await host.destination(args.path);
  const plan={method:trackMode?'export_audio_track':"export_audio_mix",appPath,settings,destination,before,
    warning:(trackMode?`Exports the selected native track output as stereo WAV without solo or mute changes. Include Return and Main Effects: ${settings.includeReturnMainEffects}. Group output can overlap child exports; effects-inclusive files need not sum to the mix. `:"Exports Main as stereo WAV through Live's native dialog. Includes current Session overrides and Main processing. ")+"Current Session overrides and mute/solo state apply. Export preferences are updated. Note, device and automation contents are not bound; the mix controls and document are rechecked. No normalization, loop rendering, MP3, video or analysis file is requested. Existing files are never overwritten."};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error("confirmation plan hash mismatch: export context changed");
  confirmations.consume(args.confirmationToken,args.planHash);
  const recheck=async()=>{
    requestSignal()?.throwIfAborted();
    if(hashPlan(await readSource())!==hashPlan(before))throw Error("audio export context changed before render");
    if(hashPlan(await host.destination(args.path))!==hashPlan(destination))throw Error("audio export destination changed");
  };
  let observed;
  try{observed=await host.render(appPath,settings,destination,{beforeExport:recheck,beforeSave:recheck,signal:requestSignal()});}
  catch(error){return {dryRun:false,requested:plan,exportRequested:error.exportRequested??null,exportVerified:false,
    dialogCleanup:error.dialogCleanup,...(error.stagingDirectory?{stagingDirectory:error.stagingDirectory}:{}),limitation:`Native export did not verify completion; never replay blindly: ${error.message}`,
    pendingUserAction:error.dialogCleanup?.cancelled!==true};}
  if(!observed.uiComplete)return {dryRun:false,requested:plan,...observed,exportVerified:false,pendingUserAction:true};
  if(trackMode&&observed.publicationVerified!==true)return {dryRun:false,requested:plan,...observed,artifactVerified:false,exportVerified:false,pendingUserAction:false};
  try{
    const evidence=await host.verify(destination,settings);
    if(trackMode&&observed.stagingEvidence&&['sha256','size','dev','ino'].some(key=>evidence[key]!==observed.stagingEvidence[key]))throw Error('published track file differs from the verified native artifact');
    const contextUnchanged=hashPlan(await readSource())===hashPlan(before);
    return {dryRun:false,requested:plan,...observed,evidence,contextUnchanged,
      artifactVerified:evidence.verified===true,
      exportVerified:false,renderCompletion:"unconfirmed",pendingUserAction:false,
      limitation:"Native settings, WAV format and stable file bytes were checked. Dialog closure cannot distinguish a completed render from cancellation leaving a valid partial file. Full-range completion, musical quality, audible monitoring and note/device/automation equivalence remain unverified."};
  }catch(error){return {dryRun:false,requested:plan,...observed,exportVerified:false,pendingUserAction:false,verificationError:error.message};}
}

export class MacAudioExportHost{
  constructor({platform=process.platform,liveSetHost=new MacLiveSetHost(),execute=run,renderTimeoutMs=120000}={}){
    this.platform=platform;this.liveSetHost=liveSetHost;this.execute=execute;this.renderTimeoutMs=renderTimeoutMs;
  }
  appPathFor(live){return this.liveSetHost.appPathFor(live);}
  async destination(path){
    if(this.platform!=="darwin")throw Error("native audio export is macOS only");
    if(typeof path!=="string"||!isAbsolute(path)||!path.endsWith(".wav"))throw Error("export destination must be an absolute .wav path");
    const name=basename(path);
    if(name.startsWith(".")||name.length>128||/[:\x00-\x1f\x7f]/u.test(name))throw Error("export filename must be visible and contain no colons or control characters");
    let parentPath;try{parentPath=await realpath(dirname(path));}catch{throw Error("export parent directory must already exist");}
    const parent=await lstat(parentPath,{bigint:true});if(!parent.isDirectory())throw Error("export parent must be a directory");
    const canonical=join(parentPath,name);
    try{await lstat(canonical);}catch(error){if(error.code==="ENOENT")return {path:canonical,name,parent:{path:parentPath,dev:String(parent.dev),ino:String(parent.ino)}};throw error;}
    throw Error("export destination already exists; choose a new filename");
  }
  async verify(destination,settings){
    const identity=async()=>{const info=await lstat(destination.path,{bigint:true});if(!info.isFile()||info.size<=0n||await realpath(destination.path)!==destination.path)throw Error("export must be a nonempty regular file");return {size:String(info.size),dev:String(info.dev),ino:String(info.ino),mtimeNs:String(info.mtimeNs)};};
    const before=await identity();
    const metadata=JSON.parse((await this.execute("ffprobe",["-v","error","-protocol_whitelist","file,pipe","-show_entries","format=format_name,duration:stream=codec_name,codec_type,sample_rate,channels,bits_per_sample","-of","json",destination.path],{timeout:10000,maxBuffer:65536})).stdout);
    const streams=metadata.streams??[],stream=streams[0],durationSeconds=Number(metadata.format?.duration);
    const expectedCodec=settings.bitDepth===32?"pcm_f32le":`pcm_s${settings.bitDepth}le`;
    if(metadata.format?.format_name!=="wav"||streams.length!==1||stream.codec_type!=="audio"||stream.codec_name!==expectedCodec||Number(stream.sample_rate)!==settings.sampleRate||Number(stream.bits_per_sample)!==settings.bitDepth||Number(stream.channels)!==2||!Number.isFinite(durationSeconds)||durationSeconds<=0)throw Error("exported audio format does not match the requested stereo PCM WAV settings");
    const digest=createHash("sha256");for await(const chunk of createReadStream(destination.path))digest.update(chunk);
    if(hashPlan(before)!==hashPlan(await identity()))throw Error("export file changed during verification");
    return {verified:true,path:destination.path,...before,sha256:digest.digest("hex"),durationSeconds,sampleRate:settings.sampleRate,bitDepth:settings.bitDepth,channels:2};
  }
  async render(appPath,settings,destination,{beforeExport,beforeSave,signal}={}){
    if(this.busy)throw Object.assign(Error("another native audio export is active"),{exportRequested:false});
    this.busy=true;
    try{return settings.renderTarget?await this.renderTrack(appPath,settings,destination,{beforeExport,beforeSave,signal}):await this.renderOwned(appPath,settings,destination,{beforeExport,beforeSave,signal});}
    finally{this.busy=false;}
  }
  async renderTrack(appPath,settings,destination,{beforeExport,beforeSave,signal}={}){
    // Live appends the track name after the Save panel filename. Keep that
    // output in an exclusive directory, then publish with a no-clobber link.
    const directory=await mkdtemp(join(destination.parent.path,'.ableton-export-'));
    const staged=await this.destination(join(directory,'audio.wav'));
    const checkDirectory=async(empty=false)=>{
      const info=await lstat(directory,{bigint:true});
      if(!info.isDirectory()||await realpath(directory)!==directory||String(info.dev)!==staged.parent.dev||String(info.ino)!==staged.parent.ino)throw Error('native export staging directory changed');
      const files=await readdir(directory,{withFileTypes:true});
      if(empty&&files.length)throw Error('native export staging directory is no longer empty');
      return files;
    };
    let observed;
    try{
      observed=await this.renderOwned(appPath,settings,staged,{
        beforeExport:async()=>{await beforeExport();await checkDirectory(true);},
        beforeSave:async()=>{await beforeSave();await checkDirectory(true);},signal});
    }catch(error){error.stagingDirectory=directory;throw error;}
    if(!observed.uiComplete)return {...observed,publicationVerified:false,stagingDirectory:directory};
    try{
      signal?.throwIfAborted();
      const files=await checkDirectory();
      if(files.length!==1||!files[0].isFile()||!files[0].name.toLowerCase().endsWith('.wav'))throw Error('expected exactly one native track WAV in staging');
      const nativePath=join(directory,files[0].name),evidence=await this.verify({path:nativePath},settings);
      if(hashPlan(await this.destination(destination.path))!==hashPlan(destination))throw Error('track export destination changed before publication');
      await checkDirectory();
      signal?.throwIfAborted();
      await link(nativePath,destination.path);
      const published=await lstat(destination.path,{bigint:true});
      const parent=await lstat(destination.parent.path,{bigint:true});
      if(!parent.isDirectory()||await realpath(destination.parent.path)!==destination.parent.path||String(parent.dev)!==destination.parent.dev||String(parent.ino)!==destination.parent.ino)throw Error('track export parent changed during publication');
      if(!published.isFile()||String(published.dev)!==evidence.dev||String(published.ino)!==evidence.ino||String(published.size)!==evidence.size)throw Error('track export publication identity changed');
      let stagingCleanup;
      try{
        const retained=await checkDirectory();
        if(retained.length!==1||retained[0].name!==files[0].name)throw Error('staging contents changed');
        const current=await lstat(nativePath,{bigint:true});
        if(!current.isFile()||String(current.dev)!==evidence.dev||String(current.ino)!==evidence.ino)throw Error('staging file identity changed');
        await unlink(nativePath);await rmdir(directory);stagingCleanup={removed:true};
      }catch(error){stagingCleanup={removed:false,error:error.message,directory};}
      return {...observed,publicationVerified:true,nativeFileName:files[0].name,stagingEvidence:evidence,stagingCleanup};
    }catch(error){return {...observed,publicationVerified:false,stagingDirectory:directory,publicationError:error.message};}
  }
  async renderOwned(appPath,settings,destination,{beforeExport,beforeSave,signal}={}){
    const canonicalApp=await realpath(appPath),executable=await realpath(`${canonicalApp}/Contents/MacOS/Live`),processes=await this.liveSetHost.runningProcesses();
    if(processes.length!==1||processes[0].path!==executable)throw Error("audio export requires exactly one running instance of the requested Live app");
    const pid=processes[0].pid;
    const dialog=async(script,input,operationSignal)=>{
      try{
        if(["prepare","commit","adoptAudioExport"].includes(input.action)){
          const focused=JSON.parse((await this.execute("/usr/bin/osascript",["-l","JavaScript",focusScript,JSON.stringify({pid,appPath:canonicalApp,windowId:input.windowId})],{timeout:10000,maxBuffer:65536,signal:operationSignal})).stdout);
          if(!focused.focused)throw Error("Live did not become visible");
        }
        return JSON.parse((await this.execute("/usr/bin/osascript",["-l","JavaScript",script,JSON.stringify({pid,...input})],{timeout:30000,maxBuffer:65536,signal:operationSignal})).stdout);
      }
      catch(error){throw Error(`Native audio export dialog: ${String(error.stderr||error.message).trim().slice(0,600)}`);}
    };
    await this.execute("/usr/bin/open",["-a",canonicalApp],{timeout:5000,signal});
    const prepared=await dialog(exportScript,{action:"prepare",settings},signal);
    let exportPressed=false,saveAttempted=false,save,saveClosed=false;
    try{
      if(!prepared.prepared)throw Error(prepared.error??"native export preparation failed");
      await beforeExport();
      const opened=await dialog(exportScript,{...prepared,action:"commit"},signal);
      if(!opened.exportPressed)throw Object.assign(Error(opened.error??"native Export button was not pressed"),{preserveDialog:opened.preserveDialog===true});
      exportPressed=true;
      save=await dialog(saveScript,{action:"adoptAudioExport",windowId:opened.saveWindowId,parent:destination.parent.path},signal);
      if(!save.prepared||save.purpose!=="Save Audio File As:")throw Error("native audio Save panel could not be identified");
      if(settings.renderTarget&&(opened.trackSelectionVerified!==true||hashPlan(opened.renderedTarget)!==hashPlan(settings.renderTarget)))throw Error('native rendered-track selection was not verified');
      await beforeSave();
      saveAttempted=true;
      const committed=await dialog(saveScript,{...save,action:"commit",parent:destination.parent.path,parentIdentity:destination.parent,name:destination.name},signal);
      if(committed.savePressed===false){saveAttempted=false;saveClosed=committed.recovery?.status==="cancelled";}
      if(!committed.savePressed)throw Object.assign(Error(committed.error??"native export Save outcome is unknown"),{exportRequested:committed.savePressed===false?false:null});
      const deadline=Date.now()+this.renderTimeoutMs;
      while(Date.now()<deadline){
        signal?.throwIfAborted();
        const status=await dialog(exportScript,{action:"status"},signal);
        if(status.uiComplete)return {exportRequested:true,uiComplete:true,...(settings.renderTarget?{trackSelectionVerified:opened.trackSelectionVerified===true,renderedTarget:opened.renderedTarget,includeReturnMainEffects:settings.includeReturnMainEffects}:{})};
        await pause(500,undefined,{signal});
      }
      return {exportRequested:true,uiComplete:false,limitation:"Native rendering or a dialog remains unresolved; inspect Live and the destination before retrying."};
    }catch(error){
      if(!saveAttempted&&!error.preserveDialog){
        try{
          if(save?.prepared&&!saveClosed)await dialog(saveScript,{...save,action:"cancel"});
          if(!exportPressed||save?.prepared)await dialog(exportScript,{...prepared,action:"cancel"});
          else throw Error("native audio Save window ownership is unavailable");
          error.dialogCleanup={cancelled:true};
        }catch(cleanupError){error.message+=`; dialog cleanup unverified: ${cleanupError.message}`;}
      }
      if(error.exportRequested===undefined)error.exportRequested=saveAttempted?null:false;
      throw error;
    }
  }
}
