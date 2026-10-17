import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {analyzeAudioFile} from './audio-analysis.mjs';
import {requestSignal} from './request-context.mjs';

const MAX_FILE_BYTES=512n*1024n*1024n;
const identity=info=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(key=>[key,String(info[key])]));
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

async function fingerprint(path){
  requestSignal()?.throwIfAborted();
  const pathBefore=await lstat(path,{bigint:true});
  if(!pathBefore.isFile()||pathBefore.size<=0n||pathBefore.size>MAX_FILE_BYTES)throw Error('comparison sources must be nonempty regular files of at most 512 MiB');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await handle.stat({bigint:true});
    if(!before.isFile()||!equal(identity(pathBefore),identity(before)))throw Error('audio reference source changed before hashing');
    const digest=createHash('sha256'),deadline=AbortSignal.timeout(30000),signal=requestSignal()?AbortSignal.any([requestSignal(),deadline]):deadline;
    for await(const chunk of handle.createReadStream({autoClose:false,signal}))digest.update(chunk);
    if(!equal(identity(before),identity(await handle.stat({bigint:true})))||!equal(identity(before),identity(await lstat(path,{bigint:true}))))throw Error('audio reference source changed during hashing');
    return {path,...identity(before),sha256:digest.digest('hex')};
  }finally{await handle.close();}
}

export async function compareAudioReference({mixPath,referencePath,mixStartSeconds=0,referenceStartSeconds=0,durationSeconds=10},{analyze=analyzeAudioFile}={}){
  if(!Number.isFinite(durationSeconds)||durationSeconds<3||durationSeconds>60)throw Error('comparison durationSeconds must be from 3 to 60');
  if([mixStartSeconds,referenceStartSeconds].some(value=>!Number.isFinite(value)||value<0))throw Error('comparison starts must be finite nonnegative seconds');
  if([mixPath,referencePath].some(path=>typeof path!=='string'||!isAbsolute(path)))throw Error('comparison requires absolute local mixPath and referencePath');
  const mixFile=await fingerprint(await realpath(mixPath)),referenceFile=await fingerprint(await realpath(referencePath));
  const measure=async(file,startSeconds)=>{
    requestSignal()?.throwIfAborted();
    const result=await analyze(file.path,{startSeconds,durationSeconds,signal:requestSignal()});
    if(result.sourcePath!==file.path||![1,2].includes(result.channels)||!Number.isFinite(result.sampleRate)||result.sampleRate<=0)throw Error('comparison requires identified mono or stereo audio sources');
    if(result.window?.startSeconds!==startSeconds||result.window?.durationSeconds!==durationSeconds)throw Error('requested comparison window exceeds source duration; choose equal complete windows');
    return {scope:'source_audio',channels:result.channels,sampleRate:result.sampleRate,window:result.window,
      integratedLufs:Number.isFinite(result.integratedLufs)?result.integratedLufs:null,
      truePeakDbtp:Number.isFinite(result.truePeakDbtp)?result.truePeakDbtp:null,
      loudnessRangeLu:Number.isFinite(result.loudnessRangeLu)?result.loudnessRangeLu:null};
  };
  const mix=await measure(mixFile,mixStartSeconds),reference=await measure(referenceFile,referenceStartSeconds);
  if(!equal(mixFile,await fingerprint(mixFile.path))||!equal(referenceFile,await fingerprint(referenceFile.path)))throw Error('audio reference source changed during comparison');
  const difference=(left,right)=>left===null||right===null?null:left-right;
  const available=mix.integratedLufs!==null&&reference.integratedLufs!==null;
  const targetLufs=available?Math.min(mix.integratedLufs,reference.integratedLufs):null;
  const mixGainDb=available?(targetLufs-mix.integratedLufs)||0:null,referenceGainDb=available?(targetLufs-reference.integratedLufs)||0:null;
  return {scope:'source_audio_windows',mix:{file:mixFile,fileUnchanged:true,measurement:mix},reference:{file:referenceFile,fileUnchanged:true,measurement:reference},
    mixMinusReference:{integratedLufs:difference(mix.integratedLufs,reference.integratedLufs),truePeakDbtp:difference(mix.truePeakDbtp,reference.truePeakDbtp),loudnessRangeLu:difference(mix.loudnessRangeLu,reference.loudnessRangeLu)},
    levelMatch:{available,reason:available?'attenuate_to_quieter_window':'finite_loudness_unavailable',applied:false,targetLufs,mixGainDb,referenceGainDb,
      predictedMixTruePeakDbtp:available&&mix.truePeakDbtp!==null?mix.truePeakDbtp+mixGainDb:null,
      predictedReferenceTruePeakDbtp:available&&reference.truePeakDbtp!==null?reference.truePeakDbtp+referenceGainDb:null},
    limitation:'Measurements describe the selected decoded source windows, not Live processing unless these files are verified renders or captures. Starts use source-file seconds and bounds use reported duration; no musical/sample alignment or damaged-media completeness proof. Whole-window LUFS matching is a review-only constant-gain proposal, not perceived equality at every moment, a mastering target, dynamics/tonal/quality judgment, stereo-width analysis or audible A/B playback. Short-window loudness range may not represent a complete song. No file or Live control was changed; file identity and hashes were observed before and after measurement, not locked against later edits.'};
}
