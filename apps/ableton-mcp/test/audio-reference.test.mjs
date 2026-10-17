import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile,writeFile,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {compareAudioReference} from '../src/audio-reference.mjs';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';
import {analyzeAudioFile} from '../src/audio-analysis.mjs';
import {withRequestSignal} from '../src/request-context.mjs';

const run=promisify(execFile);
async function fixtures(callback){
  const directory=await mkdtemp(join(tmpdir(),'cavi-reference-'));
  try{
    const mixPath=join(directory,'mix.wav'),referencePath=join(directory,'reference.wav');
    for(const [path,amplitude] of [[mixPath,.4],[referencePath,.2]])await run('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',
      `aevalsrc=${amplitude}*sin(2*PI*440*t)|${amplitude}*sin(2*PI*440*t):s=48000:d=4`,'-c:a','pcm_f32le',path]);
    return await callback({mixPath,referencePath,durationSeconds:3});
  }finally{await rm(directory,{recursive:true,force:true});}
}

test('real file comparison measures equal windows and proposes attenuation without writing',()=>fixtures(async args=>{
  const before=await Promise.all([readFile(args.mixPath),readFile(args.referencePath)]);
  const result=await compareAudioReference(args);
  assert.equal(result.scope,'source_audio_windows');
  assert.ok(Math.abs(result.mixMinusReference.integratedLufs-6.02)<.1);
  assert.ok(Math.abs(result.mixMinusReference.truePeakDbtp-6.02)<.1);
  assert.equal(result.levelMatch.available,true);
  assert.ok(Math.abs(result.levelMatch.mixGainDb+6.02)<.1);
  assert.equal(result.levelMatch.referenceGainDb,0);
  assert.equal(result.levelMatch.applied,false);
  assert.equal(result.levelMatch.targetLufs,result.reference.measurement.integratedLufs);
  assert.equal(result.mix.measurement.window.durationSeconds,3);
  for(const [index,key] of ['mix','reference'].entries()){
    assert.equal(result[key].file.sha256,createHash('sha256').update(before[index]).digest('hex'));
    assert.equal(result[key].fileUnchanged,true);
  }
  assert.deepEqual(await Promise.all([readFile(args.mixPath),readFile(args.referencePath)]),before);
}));

test('different window starts are explicit and overrun never silently shortens a comparison',()=>fixtures(async args=>{
  const result=await compareAudioReference({...args,mixStartSeconds:1,referenceStartSeconds:.5});
  assert.equal(result.mix.measurement.window.startSeconds,1);
  assert.equal(result.reference.measurement.window.startSeconds,.5);
  await assert.rejects(()=>compareAudioReference({...args,mixStartSeconds:2}),/window|duration/i);
  for(const durationSeconds of [0,2.9,61,NaN])await assert.rejects(()=>compareAudioReference({...args,durationSeconds}),/duration/i);
}));

test('silence leaves loudness matching unavailable instead of treating missing loudness as zero',()=>fixtures(async args=>{
  await run('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','4','-y',args.referencePath]);
  const result=await compareAudioReference(args);
  assert.equal(result.reference.measurement.integratedLufs,null);
  assert.equal(result.mixMinusReference.integratedLufs,null);
  assert.equal(result.levelMatch.available,false);
  assert.equal(result.levelMatch.mixGainDb,null);
  assert.equal(result.levelMatch.referenceGainDb,null);
}));

test('changes to either file while the pair is measured invalidate all comparison evidence',()=>fixtures(async args=>{
  let reads=0;
  await assert.rejects(()=>compareAudioReference(args,{analyze:async(path,options)=>{
    reads++;
    if(reads===2){const bytes=await readFile(args.mixPath);bytes[bytes.length-1]^=1;await writeFile(args.mixPath,bytes);}
    return {sourcePath:path,channels:2,sampleRate:48000,window:{startSeconds:options.startSeconds,durationSeconds:options.durationSeconds},
      integratedLufs:-12,truePeakDbtp:-3,loudnessRangeLu:0};
  }}),/changed/i);
}));

test('non-files, empty and oversized sources are refused before decoding',()=>fixtures(async args=>{
  let decodes=0;
  const options={analyze:async()=>{decodes++;throw Error('unexpected decode');}};
  await assert.rejects(()=>compareAudioReference({...args,mixPath:join(args.mixPath,'..')},options),/regular file|directory|ENOTDIR/);
  await writeFile(args.mixPath,'');await assert.rejects(()=>compareAudioReference(args,options),/nonempty/);
  await truncate(args.mixPath,512*1024*1024+1);await assert.rejects(()=>compareAudioReference(args,options),/512 MiB/);
  assert.equal(decodes,0);
}));

test('request cancellation interrupts the analyzer instead of finishing its decode',()=>fixtures(async args=>{
  const controller=new AbortController();let interruptedInsideAnalyzer=false;
  await assert.rejects(()=>withRequestSignal(controller.signal,()=>compareAudioReference(args,{analyze:async(path,options)=>{
    const timer=setTimeout(()=>controller.abort(),5);
    try{return await analyzeAudioFile(path,options);}
    catch(error){interruptedInsideAnalyzer=error.name==='AbortError';throw error;}
    finally{clearTimeout(timer);}
  }})),{name:'AbortError'});
  assert.equal(interruptedInsideAnalyzer,true);
}));

test('the production router exposes comparison read-only in all without touching Live',()=>fixtures(async args=>{
  const service=new ToolService({bridge:{request:async()=>{throw Error('file comparison must not access Live');}}}),route=createRouter(service);
  const listing=(await route({id:1,method:'tools/list'})).result.tools.find(x=>x.name==='compare_audio_reference');
  assert.equal(listing.annotations.readOnlyHint,true);
  const reply=await route({id:2,method:'tools/call',params:{name:'compare_audio_reference',arguments:args}});
  assert.equal(reply.error,undefined);assert.equal(reply.result.isError,undefined);
  assert.equal(reply.result.structuredContent.levelMatch.available,true);
  const core=createRouter(service,{toolProfile:'core'});
  assert.equal((await core({id:3,method:'tools/call',params:{name:'compare_audio_reference',arguments:args}})).error.code,-32601);
}));

test('reference workflow requires rendered provenance, musical scope and user feedback before edits',()=>{
  const text=getPrompt('compare-mix-to-reference',{request:'Compare the chorus and leave my mix alone',referencePath:'/audio/reference.wav'}).messages[0].content.text;
  for(const term of ['compare_audio_reference','capture_live_audio','get_live_audio_capture','export_audio_mix','sha256','levelMatch','balance-mix'])assert.ok(text.includes(term),term);
  assert.match(text,/equal.*duration/i);assert.match(text,/not.*quality/i);assert.match(text,/user.*hear|what.*hear/i);assert.match(text,/never.*retry blindly/i);
});
