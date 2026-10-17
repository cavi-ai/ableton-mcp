import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {MacTrackMenuHost} from './track-menu.mjs';
const run=promisify(execFile);

export async function trackBounce(bridge,confirmations,host,args){
  if(!Number.isInteger(args.expectedStateVersion))throw Error('expectedStateVersion is required');
  const read=()=>bridge.request('get_track_bounce_source',{trackId:args.trackId}),before=await read();
  if(!before.filePath?.startsWith('/')||!before.identityToken||!before.otherTracksToken)throw Error('saved Set and updated native bounce context required');
  if(before.stateVersion!==args.expectedStateVersion)throw Error('track bounce state version changed');
  if(Object.values(before.readiness).some(v=>v!==false))throw Error('bounce requires stopped playback/recording, an unarmed target and no pending launches');
  if(before.realtimeDevices?.length||before.monitoring?.value===0)throw Error('resolve external hardware or live input monitoring before bouncing');
  const plan={method:'bounce_track_in_place',trackId:args.trackId,expectedStateVersion:args.expectedStateVersion,before,
    warning:'Replaces the entire target with audio and removes its devices in both Session and Arrangement. Duplicate and mute a copy first to preserve an editable original. Includes device processing before mixer volume/pan/sends; mixer settings remain on the converted track. Uses macOS English Live on a saved Set, changes focus and navigates track headers. Exposed material and native identities are bound; automation envelopes, hidden plug-in state and external file bytes are not. No automatic undo, deletion, replay, save or playback.'};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('bounce confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  const recheck=async()=>{try{requestSignal()?.throwIfAborted();if(hashPlan(await read())!==hashPlan(before))throw Error('bounce context changed before native command');}catch(error){throw Object.assign(error,{operationRequested:false});}};
  let prepared,ui,error,cleanup;
  try{
    prepared=await host.prepare(before,{beforePrepare:recheck,signal:requestSignal()});
    ui=await host.commit(before,prepared,null,{beforeCommit:async()=>{await recheck();if((await bridge.request('get_selection_context',{})).selectedTrack?.id!==args.trackId)throw Object.assign(Error('native selected track changed before bounce'),{operationRequested:false});},signal:requestSignal()});
  }catch(failure){
    error=failure;prepared=failure.prepared??prepared;
    if(prepared&&failure.operationRequested===false)try{cleanup=await host.cancel(before,prepared);}catch(cancelError){cleanup={cancelled:false,error:cancelError.message};}
  }
  let after,files=[];
  try{after=await read();}catch(failure){error??=failure;}
  const priorPaths=new Set(before.audioClips.map(clip=>clip.path));
  const rendered=v=>!!v?.identityToken&&v.identityToken!==before.identityToken&&v.audioClips?.length>0&&v.audioClips.every(clip=>!priorPaths.has(clip.path));
  const matches=v=>v?.filePath===before.filePath&&v.otherTracksToken===before.otherTracksToken&&v.otherTracksDigest===before.otherTracksDigest&&
    v.type==='audio'&&v.deviceCount===0&&hashPlan(v.layout)===hashPlan(before.layout)&&hashPlan(v.mixer)===hashPlan(before.mixer)&&
    hashPlan(v.output)===hashPlan(before.output)&&Object.values(v.readiness).every(value=>value===false);
  if(!error&&matches(after)&&rendered(after)&&ui?.uiIdle===true)try{
    files=await host.verifyFiles(after.audioClips,{signal:requestSignal()});
    const previous=after;after=await read();if(hashPlan(after)!==hashPlan(previous))throw Error('bounced track or context changed during file inspection');
  }catch(failure){error=failure;}
  const conversionVerified=matches(after),audioFilesVerified=!error&&files.length>0&&files.every(f=>f.verified===true),bounceRequested=error?error.operationRequested??ui?.operationRequested??null:ui.operationRequested;
  const renderTransitionVerified=rendered(after),bounceVerified=!error&&conversionVerified&&renderTransitionVerified&&audioFilesVerified&&ui?.uiIdle===true&&ui.popupClosed===true;
  return {dryRun:false,requested:plan,observed:after??null,bounceRequested,bounceVerified,conversionVerified,renderTransitionVerified,audioFilesVerified,files,
    audibleEquivalenceVerified:false,completeMaterialPreservationVerified:false,ui,dialogCleanup:cleanup,
    pendingUserAction:!bounceVerified&&!!(bounceRequested!==false||error?.requiresInspection&&!prepared||prepared&&cleanup?.cancelled!==true),
    limitation:'Native conversion, clip layout, mixer values and file coverage do not prove audio equivalence, every automation/hidden state, source content preservation or a saved Set. Keep the original for comparison. Inspect partial or uncertain results; never replay, delete or undo automatically.',
    ...(!bounceVerified?{verificationError:error?.message??'native conversion, new render sources, layout, controls or file coverage did not verify'}:{})};
}

export class MacTrackBounceHost extends MacTrackMenuHost{
  constructor(options={}){super({...options,operation:'bounce'});}
  async verifyFiles(clips,{signal}={}){
    if(!Array.isArray(clips)||!clips.length||clips.length>128)throw Error('native bounced audio inventory unavailable');
    const paths=new Map(),result=[];
    for(const clip of clips){
      signal?.throwIfAborted();
      if(!isAbsolute(clip.path??'')||!Number.isFinite(clip.requiredEndSamples)||clip.requiredEndSamples<=0||!Number.isFinite(clip.sampleRate)||clip.sampleRate<=0)throw Error('native bounced source coverage unavailable');
      let file=paths.get(clip.path);
      if(!file){
        const path=await realpath(clip.path),before=await stat(path,{bigint:true});if(!before.isFile()||before.size<=44n)throw Error('bounced audio file is unavailable');
        const metadata=JSON.parse((await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=format_name,duration:stream=codec_name,codec_type,sample_rate,channels,duration_ts,time_base','-of','json',path],{timeout:10000,maxBuffer:65536,signal})).stdout),stream=metadata.streams?.find(s=>s.codec_type==='audio');
        const rate=Number(stream?.sample_rate),base=String(stream?.time_base).split('/').map(Number),samples=Number(stream?.duration_ts)*base[0]/base[1]*rate;
        if(!/^(wav|aiff)$/u.test(metadata.format?.format_name)||!/^pcm_/u.test(stream?.codec_name)||![1,2].includes(Number(stream?.channels))||!Number.isFinite(samples)||samples<=0||!Number.isFinite(rate)||rate<=0)throw Error('bounced file format or sample coverage unavailable');
        const after=await stat(path,{bigint:true});if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs)throw Error('bounced audio file changed during verification');
        file={path,bytes:Number(after.size),sampleRate:rate,channels:Number(stream.channels),samples};paths.set(clip.path,file);
      }
      if(file.sampleRate!==clip.sampleRate||file.samples+1<clip.requiredEndSamples||Number.isFinite(clip.nativeLengthSamples)&&file.samples+1<clip.nativeLengthSamples)throw Error('bounced file does not cover the native clip source');
      result.push({...file,requiredEndSamples:clip.requiredEndSamples,verified:true});
    }
    return result;
  }
}
