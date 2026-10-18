import test from 'node:test';
import assert from 'node:assert/strict';
import {compareReversedPcm,reverseAudioClip,readReversalAudio,readBoundedAudioBytes,MacAudioReverseHost} from '../src/audio-reverse.mjs';
import {ConfirmationStore} from '../src/confirmation-store.mjs';
import {mkdtemp,writeFile,rm,symlink,lstat,open,rename,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRouter} from '../src/server.mjs';
const pcm=values=>{const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeFloatLE(v,i*4));return b;};
test('sample verification reverses frames while preserving stereo channel order',()=>{
 const source=pcm([.1,.2,.3,.4,.5,.6]);
 assert.equal(compareReversedPcm(source,pcm([.5,.6,.3,.4,.1,.2]),2).matched,true);
 assert.equal(compareReversedPcm(source,pcm([.6,.5,.4,.3,.2,.1]),2).matched,false);
 assert.equal(compareReversedPcm(source,source,2).matched,false);
 assert.throws(()=>compareReversedPcm(source,pcm([.1,.2]),2));
 assert.throws(()=>compareReversedPcm(pcm([NaN]),pcm([NaN]),1));
});
function fixture(){
 let current={stateVersion:3,setFingerprint:'set',identityToken:'clip',ownerIdentityToken:'owner',trackId:'track-0',clipId:'track-0:clip-0',
  filePath:'/Set.als',name:'Reverse me',audio:{source:{path:'/source.wav'},gain:{value:.4},pitch:{coarse:0,fine:0},warping:true,warpMode:{value:0}},timing:{stateVersion:3},muted:false};
 const calls=[],bridge={async request(name){
  if(name==='get_audio_clip_reverse_source')return structuredClone(current);
  if(name==='select_audio_clip_reverse_source'){calls.push('select');current.stateVersion=4;current.timing.stateVersion=4;return {stateVersion:4,source:structuredClone(current)};}
  if(name==='get_selection_context')return {setFingerprint:'set',selectedTrack:{id:'track-0'},detailClip:{trackId:'track-0',clipId:'track-0:clip-0'}};
  throw Error(name);
 }},host={async context(){return {document:{id:1},sourceArtifact:{sha256:'original'}};},async recheck(){},
  async reverse(source,native,{beforePress}){await beforePress();calls.push('reverse');current.audio.source.path='/reversed.wav';return {reverseRequested:true};},
  async verify(){return {sourceBytesPreserved:true,contentReversalVerified:true,comparison:{matched:true}};}};
 return {bridge,host,calls,store:new ConfirmationStore(),current};
}
const args={trackId:'track-0',clipId:'track-0:clip-0',expectedStateVersion:3};
const plan=f=>reverseAudioClip(f.bridge,f.store,f.host,args);
const execute=(f,p)=>reverseAudioClip(f.bridge,f.store,f.host,{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
test('confirmed reversal selects once and requires independent content verification',async()=>{
 const f=fixture(),p=await plan(f);assert.deepEqual(f.calls,[]);
 const result=await execute(f,p);assert.equal(result.reverseVerified,true);assert.deepEqual(f.calls,['select','reverse']);
 await assert.rejects(execute(f,p));assert.deepEqual(f.calls,['select','reverse']);
});
test('manual clip or file changes invalidate confirmed reversal before selection',async()=>{
 for(const change of [f=>f.current.audio.gain.value=.8,f=>f.current.identityToken='replacement',f=>f.host.context=async()=>({document:{id:1},sourceArtifact:{sha256:'changed'}})]){
  const f=fixture(),p=await plan(f);change(f);await assert.rejects(execute(f,p));assert.deepEqual(f.calls,[]);
 }
});
test('a selected-clip race refuses before the only reverse press',async()=>{
 const f=fixture(),p=await plan(f);f.host.reverse=async(s,n,{beforePress})=>{f.current.audio.gain.value=.8;await beforePress();f.calls.push('reverse');};
 const result=await execute(f,p);assert.equal(result.reverseVerified,false);assert.deepEqual(f.calls,['select']);
});
test('manual edits during file inspection refuse before Reverse',async()=>{
 const f=fixture(),p=await plan(f);f.host.recheck=async()=>{f.current.audio.gain.value=.8;};
 const result=await execute(f,p);assert.equal(result.reverseVerified,false);assert.deepEqual(f.calls,['select']);
});
test('verified native clip replacement retains exact owner and reports identity change',async()=>{
 const f=fixture(),reverse=f.host.reverse;f.host.reverse=async(...a)=>{const result=await reverse(...a);f.current.identityToken='native replacement';return result;};
 const result=await execute(f,await plan(f));assert.equal(result.reverseVerified,true);assert.equal(result.clipIdentityPreserved,false);assert.equal(result.clipTargetVerified,true);
});
test('owner replacement cannot verify even when decoded content matches',async()=>{
 const f=fixture(),reverse=f.host.reverse;f.host.reverse=async(...a)=>{const result=await reverse(...a);f.current.ownerIdentityToken='other owner';return result;};
 const result=await execute(f,await plan(f));assert.equal(result.reverseVerified,false);assert.equal(result.clipTargetVerified,false);
});
test('unknown UI outcomes and failed sample verification retain partial state without replay',async()=>{
 for(const change of [f=>f.host.reverse=async()=>{throw Object.assign(Error('lost reverse receipt'),{reverseRequested:null});},
  f=>f.host.verify=async()=>({sourceBytesPreserved:true,contentReversalVerified:false})]){
  const f=fixture();change(f);const result=await execute(f,await plan(f));assert.equal(result.reverseVerified,false);
  if(result.verificationError==='lost reverse receipt')assert.equal(result.reverseRequested,null);
  assert.ok(f.calls.filter(c=>c==='reverse').length<=1);assert.ok(result.verificationError);
 }
});
test('file verification measures reversed stereo PCM and detects source changes and symlinks',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cavi-reverse-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const wave=values=>{const data=pcm(values),b=Buffer.alloc(44+data.length);b.write('RIFF');b.writeUInt32LE(36+data.length,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(3,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(384000,28);b.writeUInt16LE(8,32);b.writeUInt16LE(32,34);b.write('data',36);b.writeUInt32LE(data.length,40);data.copy(b,44);return b;};
 const source=join(root,'Source.wav'),after=join(root,'Reverse.wav');
 await writeFile(source,wave([.1,.2,.3,.4,.5,.6]));await writeFile(after,wave([.5,.6,.3,.4,.1,.2]));
 const expected=(await readReversalAudio(source)).artifact,host=new MacAudioReverseHost();
 const verified=await host.verify(expected,after);assert.equal(verified.contentReversalVerified,true);assert.equal(verified.sourceBytesPreserved,true);
 await writeFile(after,wave([.6,.5,.4,.3,.2,.1]));assert.equal((await host.verify(expected,after)).contentReversalVerified,false);
 await symlink(source,join(root,'Link.wav'));await assert.rejects(readReversalAudio(join(root,'Link.wav')),/regular|symlink/);
 await writeFile(source,wave([.2,.2,.2,.2,.2,.2]));await assert.rejects(host.verify(expected,after),/original audio source changed/);
});
test('reverse tool stays outside core and requires exact guarded clip arguments',async()=>{
 let calls=0;const service={call:async()=>{calls++;return {};}};
 const core=createRouter(service,{toolProfile:'core'}),all=createRouter(service);
 assert.equal((await core({id:1,method:'tools/call',params:{name:'reverse_audio_clip',arguments:args}})).error.code,-32601);
 assert.equal((await all({id:2,method:'tools/call',params:{name:'reverse_audio_clip',arguments:{trackId:'track-0'}}})).error.code,-32602);
 assert.equal(calls,0);
});
test('opened replacement and oversized source are refused before reading bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cavi-reverse-open-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'Source.wav');await writeFile(path,Buffer.from('first'));
 const expected=await lstat(path,{bigint:true});await rename(path,join(root,'Original.wav'));await writeFile(path,Buffer.from('other'));
 let h=await open(path,'r');try{await assert.rejects(readBoundedAudioBytes(h,expected),/changed|identity/);}finally{await h.close();}
 await truncate(path,64*1024*1024+1);const oversized=await lstat(path,{bigint:true});
 h=await open(path,'r');try{await assert.rejects(readBoundedAudioBytes(h,oversized),/64 MiB|bounds/);}finally{await h.close();}
});
