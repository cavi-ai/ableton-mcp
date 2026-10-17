import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
const target={trackId:'track-0',deviceId:'track-0:device-0'};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'simpler-')),sourcePath=join(root,'tone.wav');await writeFile(sourcePath,'fixture audio');t.after(()=>rm(root,{recursive:true,force:true}));
  const before={stateVersion:4,setFingerprint:'set-a',identityToken:'native-device-a',...target,
    device:{id:target.deviceId,className:'OriginalSimpler',name:'Simpler'},track:{id:'track-0',armed:false,frozen:false,monitoring:1,firedSlotIndex:-1},
    canReplaceSample:true,multiSampleMode:false,playbackMode:{value:0,name:'classic'},playingPositionEnabled:false,sample:null,parameters:[],
    recording:{isPlaying:false,arrangement:{record:false},session:{record:false}}};
  const writes=[],receipt={stateVersion:5,...target,verified:true,sample:{path:sourcePath,lengthFrames:48000,sampleRate:48000,startMarkerFrames:0,endMarkerFrames:48000},playbackMode:{value:1,name:'one-shot'}};
  const service=new ToolService({bridge:{request:async(method,args)=>{
    if(method==='get_simpler_sample_state')return structuredClone(before);
    if(method==='get_live_state')return {stateVersion:4};
    if(method==='load_simpler_sample'){writes.push(args);return structuredClone(receipt);}
    throw Error(method);
  }}});
  return {service,before,receipt,writes,args:{...target,sourcePath,playbackMode:'one-shot',expectedStateVersion:4}};
}
const execution=(args,plan)=>({...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});

test('Simpler sample read is inert and loading binds the native device, file version and optional mode',async t=>{
  const {service,before,writes,args}=await fixture(t),read=await service.call('get_simpler_sample_state',target);
  assert.deepEqual(read,before);const plan=await service.call('load_simpler_sample',args);
  assert.deepEqual(plan.plan.before,before);assert.equal(plan.plan.sourcePath,await realpath(args.sourcePath));assert.ok(plan.plan.sourceFile.inode);assert.equal(plan.plan.playbackMode,1);assert.equal(writes.length,0);
  const result=await service.call('load_simpler_sample',execution(args,plan));assert.equal(result.observed.verified,true);assert.equal(writes.length,1);
  await assert.rejects(service.call('load_simpler_sample',execution(args,plan)));assert.equal(writes.length,1);
});

test('replacing a loaded sample is explicit and changed native or file state invalidates confirmation',async t=>{
  for(const kind of ['native','file','loaded']){
    const {service,before,writes,args}=await fixture(t);
    if(kind==='loaded')before.sample={path:join(tmpdir(),'original.wav'),lengthFrames:48000,sampleRate:48000,startMarkerFrames:0,endMarkerFrames:48000};
    if(kind==='loaded')await assert.rejects(service.call('load_simpler_sample',args),/allowReplace/);
    const input={...args,allowReplace:true},plan=await service.call('load_simpler_sample',input);
    if(kind==='file')await writeFile(args.sourcePath,'changed sample version');else before.identityToken='replacement';
    await assert.rejects(service.call('load_simpler_sample',execution(input,plan)));assert.equal(writes.length,0);
  }
});

test('Simpler loading refuses unsupported or active targets and mismatched native receipts',async t=>{
  for(const change of [b=>b.multiSampleMode=true,b=>b.canReplaceSample=false,b=>b.track.frozen=true,b=>b.track.armed=true,
    b=>b.track.monitoring=0,b=>b.track.firedSlotIndex=0,b=>b.recording.isPlaying=true,b=>b.recording.arrangement.record=true,
    b=>b.recording.session.record=true,b=>b.playingPositionEnabled=true,b=>b.device.className='MultiSampler',b=>delete b.identityToken]){
    const {service,before,writes,args}=await fixture(t);change(before);await assert.rejects(service.call('load_simpler_sample',args));assert.equal(writes.length,0);
  }
  for(const change of [r=>r.verified=false,r=>r.deviceId='track-0:device-1',r=>r.sample.path='/different.wav',r=>r.playbackMode.value=0,
    r=>r.sample.sampleRate=Infinity,r=>r.sample.endMarkerFrames=48001]){
    const {service,receipt,args}=await fixture(t),plan=await service.call('load_simpler_sample',args);change(receipt);
    await assert.rejects(service.call('load_simpler_sample',execution(args,plan)),/readback mismatch/);
  }
});

test('Simpler tools validate scope, annotations, all-profile routing and workflow discovery',async t=>{
  const {service,args}=await fixture(t);
  for(const extra of [{trackId:'return-0'},{deviceId:'track-1:device-0'},{deviceId:'track-0:device-00'},{sourcePath:'relative.wav'},
    {allowReplace:1},{playbackMode:'guess'},{expectedStateVersion:undefined}])await assert.rejects(service.call('load_simpler_sample',{...args,...extra}));
  const router=createRouter(service),core=createRouter(service,{toolProfile:'core'}),listed=(await router({id:1,method:'tools/list'})).result.tools;
  assert.equal(listed.find(t=>t.name==='get_simpler_sample_state').annotations.readOnlyHint,true);
  assert.equal(listed.find(t=>t.name==='load_simpler_sample').annotations.destructiveHint,true);
  assert.equal((await core({id:2,method:'tools/call',params:{name:'get_simpler_sample_state',arguments:target}})).error.code,-32601);
  assert.equal((await router({id:3,method:'tools/call',params:{name:'get_simpler_sample_state',arguments:target}})).result.structuredContent.identityToken,'native-device-a');
  const workflow=await service.call('get_producer_workflow',{workflow:'build-sample-instrument',arguments:{request:'Build a melodic part from this named sample, preserve the current instrument.',mode:'collaborative'}});
  assert.ok(workflow.messages.length);
});
