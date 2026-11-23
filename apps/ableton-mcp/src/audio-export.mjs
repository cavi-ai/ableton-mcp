import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {realpath,lstat,mkdtemp,readdir,link,unlink,rmdir,copyFile} from "node:fs/promises";
import {createReadStream,constants} from "node:fs";
import {createHash} from "node:crypto";
import {isAbsolute,dirname,basename,join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as pause} from "node:timers/promises";
import {hashPlan} from "./confirmation-store.mjs";
import {beginGuardedWrite} from "./guarded-write.mjs";
import {requestSignal} from "./request-context.mjs";
import {MacLiveSetHost} from "./live-set-host.mjs";

const run=promisify(execFile);
const exportScript=fileURLToPath(new URL("./live-audio-export-dialog.js",import.meta.url));
const saveScript=fileURLToPath(new URL("./live-set-save-dialog.js",import.meta.url));
const focusScript=fileURLToPath(new URL("./live-app-focus.js",import.meta.url));
const absent=async path=>{try{await lstat(path);return false;}catch(error){return error.code==="ENOENT";}};

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
  const reply=beginGuardedWrite(confirmations,plan,args,{mismatch:"confirmation plan hash mismatch: export context changed"});if(reply)return reply;
  const recheck=async()=>{
    requestSignal()?.throwIfAborted();
    if(hashPlan(await readSource())!==hashPlan(before))throw Error("audio export context changed before render");
    if(hashPlan(await host.destination(args.path))!==hashPlan(destination))throw Error("audio export destination changed");
  };
  let observed;
  try{observed=await host.render(appPath,settings,destination,{beforeExport:recheck,beforeSave:recheck,signal:requestSignal()});}
  catch(error){return {dryRun:false,requested:plan,exportRequested:error.exportRequested??null,exportVerified:false,
    dialogCleanup:error.dialogCleanup,...(error.stagingDirectory?{stagingDirectory:error.stagingDirectory}:{}),limitation:`Native export did not verify completion; never replay blindly: ${error.message}`,
    ...(error.blockingDialogs?{blockingDialogs:error.blockingDialogs}:{}),...(error.dialogStateError?{dialogStateError:error.dialogStateError}:{}),
    ...(error.blockingDialogs?.length?{recovery:"get_live_dialog_state reads these dialogs; cancel_live_export_dialog cancels only an identified Export Audio/Video dialog or its export Save panel."}:{}),
    ...(error.exportPress?{exportPress:error.exportPress}:{}),retrySafe:error.retrySafe===true,
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
    // The dialog sequence uses accessibility on the Live process already on screen. It does not raise Live.
    const exportPress={path:"accessibility",steps:{},keys:[],activations:0,focus:{before:null,activations:0,returned:null,returnedTo:null},observed:{}};
    const record=(name,reply)=>{
      const {steps={},keys=[],activations=0,...observed}=reply?.exportPress??{};
      for(const [step,kind] of Object.entries(steps))exportPress.steps[step]=exportPress.steps[step]&&exportPress.steps[step]!==kind?`${exportPress.steps[step]}+${kind}`:kind;
      exportPress.keys.push(...keys);exportPress.activations+=activations;
      if(Object.keys(observed).length)exportPress.observed[name]=observed;
      if(exportPress.keys.length)exportPress.path="keyFallback";
    };
    const osascript=async(script,input,operationSignal,timeout=30000)=>JSON.parse((await this.execute("/usr/bin/osascript",["-l","JavaScript",script,JSON.stringify(input)],{timeout,maxBuffer:65536,signal:operationSignal})).stdout);
    const failure=error=>String(error.stderr||error.message).trim().slice(0,600);
    const dialog=async(script,input,operationSignal)=>{
      try{const reply=await osascript(script,{pid,...input},operationSignal);record(`${script===saveScript?"save":"export"}.${input.action}`,reply);return reply;}
      catch(error){throw Error(`Native audio export dialog: ${failure(error)}`);}
    };
    let returnTo=null,focusSettled=false;
    const bringLive=async()=>{
      let focused;
      try{focused=await osascript(focusScript,{pid,appPath:canonicalApp},signal,15000);}
      catch(error){throw Error(`Live focus: ${failure(error)}; nothing was pressed`);}
      const activations=Number.isInteger(focused.activations)?focused.activations:0;
      exportPress.focus.before=focused.previous?.name??focused.previous?.bundleIdentifier??null;
      exportPress.focus.activations=activations;exportPress.activations+=activations;
      if(Number.isInteger(focused.previous?.pid)&&focused.previous.pid!==pid)returnTo=focused.previous;
      if(focused.focused!==true)throw Error("Live window is not on screen; nothing was pressed");
    };
    // Cleanup reads the windows where they are. A miss leaves cancellation to accessibility alone.
    const refront=async()=>{
      try{const shown=await osascript(focusScript,{pid,appPath:canonicalApp},undefined,15000);exportPress.activations+=shown.activations??0;exportPress.focus.cleanupFront=shown.focused===true;}
      catch{exportPress.focus.cleanupFront=false;}
    };
    // Focus was never taken, so the app that was already in front stays there.
    const giveBack=async()=>{
      if(focusSettled)return;focusSettled=true;
      if(!returnTo)return;
      exportPress.focus.returned=true;exportPress.focus.returnedTo=returnTo.name??returnTo.bundleIdentifier??null;
    };
    let prepared,exportPressed=false,saveAttempted=false,save,saveClosed=false,target=destination;
    try{
      await bringLive();
      prepared=await dialog(exportScript,{action:"prepare",settings},signal);
      // A dialog this call did not open is never cancelled here; its identity is reported.
      if(prepared.blocked)throw Object.assign(Error(prepared.error??"Resolve the existing Live dialog before audio export"),{preserveDialog:true,blockingDialogs:prepared.dialogs??[]});
      if(!prepared.prepared)throw Error(prepared.error??"native export preparation failed");
      await beforeExport();
      const opened=await dialog(exportScript,{...prepared,action:"commit"},signal);
      if(!opened.exportPressed)throw Object.assign(Error(opened.error??"native Export button was not pressed"),{preserveDialog:opened.preserveDialog===true});
      exportPressed=true;
      if(!Number.isInteger(opened.saveWindowId))throw Error(opened.error??"native audio Save panel did not appear");
      save=await dialog(saveScript,{action:"adoptAudioExport",windowId:opened.saveWindowId,parent:destination.parent.path,relocate:!settings.renderTarget},signal);
      if(!save.prepared||save.purpose!=="Save Audio File As:")throw Error("native audio Save panel could not be identified");
      if(settings.renderTarget&&(opened.trackSelectionVerified!==true||hashPlan(opened.renderedTarget)!==hashPlan(settings.renderTarget)))throw Error('native rendered-track selection was not verified');
      // A panel showing another folder saves there; the verified file is then moved to the requested path.
      const folder=save.panelState?.folder;
      if(typeof folder!=="string"||!isAbsolute(folder))throw Error("native audio Save panel folder is unavailable");
      if(folder!==destination.parent.path){
        if(settings.renderTarget)throw Error("native audio Save panel shows another folder");
        const shown=await this.destination(join(folder,destination.name));
        if(shown.parent.path!==destination.parent.path)target=shown;
      }
      await beforeSave();
      saveAttempted=true;
      const committed=await dialog(saveScript,{...save,action:"commit",parent:folder,parentIdentity:target.parent,name:target.name},signal);
      // Live stays in front while it renders; focus goes back once the render finished or the wait ended.
      // A refused or unknown Save gives focus back after cleanup.
      if(committed.savePressed===false){saveAttempted=false;saveClosed=committed.recovery?.status==="cancelled";}
      if(!committed.savePressed)throw Object.assign(Error(committed.error??"native export Save outcome is unknown"),{exportRequested:committed.savePressed===false?false:null});
      const deadline=Date.now()+this.renderTimeoutMs;
      while(Date.now()<deadline){
        signal?.throwIfAborted();
        const status=await dialog(exportScript,{action:"status"},signal);
        if(status.uiComplete){
          await giveBack();
          const done={exportRequested:true,uiComplete:true,exportPress,...(settings.renderTarget?{trackSelectionVerified:opened.trackSelectionVerified===true,renderedTarget:opened.renderedTarget,includeReturnMainEffects:settings.includeReturnMainEffects}:{})};
          if(target!==destination)done.relocation=await this.relocate(target,destination,settings);
          return done;
        }
        await pause(500,undefined,{signal});
      }
      await giveBack();
      return {exportRequested:true,uiComplete:false,exportPress,...(target!==destination?{nativePath:target.path}:{}),limitation:"Native rendering or a dialog remains unresolved; inspect Live and the destination before retrying."};
    }catch(error){
      if(!saveAttempted&&!error.preserveDialog){
        // Live shows Export Audio/Video again after its Save panel closes only while it is in front.
        if(prepared?.prepared)await refront();
        try{
          if(save?.prepared&&!saveClosed)await dialog(saveScript,{...save,action:"cancel"});
          // A sent Export press whose Save panel was never adopted leaves that panel to the export cleanup.
          await dialog(exportScript,{...prepared,action:"cancel",exportPressed:exportPressed&&!save?.prepared});
          error.dialogCleanup={cancelled:true};
        }catch(cleanupError){
          // This export's own dialogs whose window is unreadable behind another app close with Live in front again.
          try{error.dialogCleanup=await this.#cancelOwnExportDialogs(pid,canonicalApp);}
          catch(recoveryError){error.message+=`; dialog cleanup unverified: ${cleanupError.message}; ${recoveryError.message}`;}
        }
      }
      if(!saveAttempted&&!error.preserveDialog&&error.dialogCleanup?.cancelled!==true){
        try{error.blockingDialogs=(await dialog(exportScript,{action:"inspect"})).dialogs;}
        catch(inspectError){error.dialogStateError=inspectError.message;}
      }
      // Save was never pressed, every owned dialog closed and the file is absent: planning again is safe.
      if(!saveAttempted&&error.dialogCleanup?.cancelled===true){
        try{const after=await dialog(exportScript,{action:"inspect"});error.retrySafe=after.blocked===false&&Array.isArray(after.dialogs)&&!after.dialogs.length&&await absent(destination.path)&&await absent(target.path);}
        catch(inspectError){error.retrySafe=false;error.dialogStateError=inspectError.message;}
      }
      await giveBack();
      error.exportPress=exportPress;
      if(error.exportRequested===undefined)error.exportRequested=saveAttempted?null:false;
      throw error;
    }
  }
  // Moves a verified export from the Save panel's folder to the requested path without overwriting.
  async relocate(from,to,settings){
    try{
      const native=await this.verify(from,settings);
      if(hashPlan(await this.destination(to.path))!==hashPlan(to))throw Error("export destination changed before the move");
      let method="link";
      try{await link(from.path,to.path);}
      catch(error){if(error.code!=="EXDEV")throw error;method="copy";await copyFile(from.path,to.path,constants.COPYFILE_EXCL);}
      const moved=await this.verify(to,settings);
      if(moved.sha256!==native.sha256||moved.size!==native.size)throw Error("moved export differs from the native file");
      const current=await lstat(from.path,{bigint:true});
      if(String(current.dev)!==native.dev||String(current.ino)!==native.ino)throw Error("native export file changed during the move");
      await unlink(from.path);
      return {moved:true,from:from.path,to:to.path,method,size:moved.size,sha256:moved.sha256,durationSeconds:moved.durationSeconds};
    }catch(error){return {moved:false,from:from.path,to:to.path,error:error.message};}
  }
  async liveProcess(){
    if(this.platform!=="darwin")throw Error("native Live dialogs are macOS only");
    const processes=await this.liveSetHost.runningProcesses(),binary="/Contents/MacOS/Live";
    if(processes.length!==1||!processes[0].path.endsWith(`.app${binary}`))throw Error("native Live dialogs require exactly one running Live app");
    return {pid:processes[0].pid,appPath:processes[0].path.slice(0,-binary.length)};
  }
  // Reads Live's blocking native dialogs in the background; nothing is pressed.
  async nativeDialogs({signal}={}){
    const live=await this.liveProcess();
    return {...live,...await this.#dialogScript({pid:live.pid,action:"inspect"},signal)};
  }
  async cancelNativeDialogs(targets,{signal}={}){
    if(this.busy)throw Error("another native audio export is active and owns its dialog cleanup");
    const live=await this.liveProcess();
    if(targets.every(target=>Number.isInteger(target.windowId)))return {...live,...await this.#dialogScript({pid:live.pid,action:"cancelLeftover",targets},signal)};
    return {...live,...await this.#cancelInFront(live,targets,signal)};
  }
    // A dialog without a window id is cancelled only when that Live window is already on screen.
    async #cancelInFront(live,planned,signal){
    const focusInput={pid:live.pid,appPath:await realpath(live.appPath)};
    const shown=JSON.parse((await this.execute("/usr/bin/osascript",["-l","JavaScript",focusScript,JSON.stringify(focusInput)],{timeout:15000,maxBuffer:65536,signal})).stdout);
    const previous=shown.previous;
    const focus={activations:Number.isInteger(shown.activations)?shown.activations:0,before:previous?.name??null,returned:null,returnedTo:null};
    if(shown.focused!==true)throw Object.assign(Error("Live window is not on screen; no Cancel was pressed"),{focus});
    const current=(await this.#dialogScript({pid:live.pid,action:"inspect"},signal)).dialogs??[];
    const same=samePlannedExportDialogs(planned,current);
    if(!same)throw Object.assign(Error("Native dialogs changed; no Cancel was pressed"),{focus});
    const result=await this.#dialogScript({pid:live.pid,action:"cancelLeftover",targets:current.map(({identity,windowId,title,sheetCount})=>({identity,windowId,title,sheetCount}))},signal);
    return {...result,focus};
  }
  // After this export's own cancel failed: only its Export Audio/Video dialog and Save panel, one each and without a sheet, are cancelled.
  async #cancelOwnExportDialogs(pid,appPath){
    const dialogs=(await this.#dialogScript({pid,action:"inspect"})).dialogs??[];
    if(!dialogs.length)return {cancelled:true,alreadyClosed:true};
    if(dialogs.some(d=>!exportKinds.includes(d.identity)||d.sheet||d.sheetCount)||exportKinds.some(kind=>dialogs.filter(d=>d.identity===kind).length>1))throw Error("a remaining dialog is not this export's own");
    const result=await this.#cancelInFront({pid,appPath},dialogs);
    if(result.blocked!==false)throw Error("export dialogs remain after Cancel");
    return {cancelled:true,recovered:true,focus:result.focus};
  }
  async #dialogScript(input,signal){
    try{return JSON.parse((await this.execute("/usr/bin/osascript",["-l","JavaScript",exportScript,JSON.stringify(input)],{timeout:30000,maxBuffer:262144,signal})).stdout);}
    catch(error){signal?.throwIfAborted();throw Error(`Native Live dialog: ${String(error.stderr||error.message).trim().slice(0,600)}`);}
  }
}

const exportKinds=["exportAudioVideo","exportSavePanel"];

export function exportWindowIdAgrees(plannedId,currentId){
  if(Number.isInteger(plannedId)&&Number.isInteger(currentId))return plannedId===currentId;
  return true;
}

export function samePlannedExportDialogs(planned,current){
  return Array.isArray(planned)&&Array.isArray(current)&&planned.length===current.length&&planned.every((target,index)=>{
    const dialog=current[index];
    return dialog?.identity===target.identity&&dialog.title===target.title&&dialog.sheetCount===target.sheetCount&&
      Number.isInteger(dialog.windowId)&&exportWindowIdAgrees(target.windowId,dialog.windowId);
  });
}

// Cancels a leftover Export Audio/Video dialog or its Save panel that no live call owns.
export async function cancelLiveExportDialog(confirmations,host,args){
  const observe=async()=>{
    const state=await host.nativeDialogs({signal:requestSignal()}),dialogs=state.dialogs??[];
    const refuse=reason=>{throw Object.assign(Error(`${reason}; no Cancel was pressed. Blocking dialogs: ${JSON.stringify(dialogs)}`),{code:"NATIVE_DIALOG_REFUSED",blockingDialogs:dialogs});};
    if(!dialogs.length)refuse("Live shows no blocking native dialog");
    if(dialogs.some(d=>!exportKinds.includes(d.identity)))refuse("A blocking dialog is not Live's Export Audio/Video dialog or its export Save panel and is not answered");
    // An identified export dialog without a window id sits behind another app; the cancel reads it again with Live in front.
    if(exportKinds.some(kind=>dialogs.filter(d=>d.identity===kind).length>1)||dialogs.some(d=>d.sheet||d.sheetCount))
      refuse("The export dialog identity is ambiguous or it shows a sheet");
    return {method:"cancel_live_export_dialog",pid:state.pid,appPath:state.appPath,
      targets:dialogs.map(({identity,windowId,title,sheetCount,buttons})=>({identity,windowId,title,sheetCount,buttons}))};
  };
  const plan=await observe();
  if(args.dryRun!==false)return beginGuardedWrite(confirmations,plan,args,{preview:{
    warning:"Presses Cancel once on each listed window, the export Save panel before Export Audio/Video, then on the Export Audio/Video dialog Live shows again after that Save panel closes. A listed window that is not already on screen is left alone. No audio is rendered, no file is written and no other dialog is answered."}});
  // A window id reads null while Live is behind another app; a planned and a current id must match when both are read.
  const planned=confirmations.consume(args.confirmationToken,args.planHash),unread=p=>({...p,targets:p.targets.map(t=>({...t,windowId:null}))});
  if(hashPlan(unread(planned))!==hashPlan(unread(plan))||!planned.targets.every((target,index)=>exportWindowIdAgrees(target.windowId,plan.targets[index].windowId)))
    throw Error("confirmation plan hash mismatch: native dialogs changed");
  let result;
  try{result=await host.cancelNativeDialogs(plan.targets,{signal:requestSignal()});}
  catch(error){
    requestSignal()?.throwIfAborted();
    let after;try{after=await host.nativeDialogs({signal:requestSignal()});}catch{/* The error below stays authoritative. */}
    return {dryRun:false,requested:plan,cancelled:false,observationError:String(error.message??error).slice(0,600),
      ...(after?{blocked:after.blocked,dialogs:after.dialogs}:{}),...(error.focus?{focus:error.focus}:{}),pendingUserAction:true,
      limitation:"Cancel closure was not verified. Read get_live_dialog_state before retrying; the error states whether Cancel was pressed."};
  }
  return {dryRun:false,requested:plan,cancelled:result.cancelled===true,closed:result.closed,blocked:result.blocked,dialogs:result.dialogs,
    ...(result.focus?{focus:result.focus}:{}),pendingUserAction:result.blocked===true};
}
