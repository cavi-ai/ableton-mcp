import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

const target={trackId:'track-0',deviceId:'track-0:device-0'};
function fixture(){
  const before={stateVersion:4,setFingerprint:'set-a',identityToken:'sample-a',...target,
    device:{id:target.deviceId,className:'OriginalSimpler'},track:{id:'track-0',armed:false,frozen:false,monitoring:1,firedSlotIndex:-1},
    multiSampleMode:false,playingPositionEnabled:false,playbackMode:{value:0,name:'classic'},parameters:[],
    recording:{isPlaying:false,arrangement:{record:false},session:{record:false}},
    sample:{path:'/sample.wav',lengthFrames:48000,sampleRate:48000,startMarkerFrames:0,endMarkerFrames:47999,gain:.5,warping:false,slicesFrames:[0]}};
  const writes=[],receipt={stateVersion:5,...target,verified:true,identityToken:'sample-a',
    region:{startMarkerFrames:12000,endMarkerFrames:47999},sample:{...before.sample,startMarkerFrames:12000}};
  const service=new ToolService({bridge:{request:async(method,args)=>{
    if(method==='get_simpler_sample_state')return structuredClone(before);
    if(method==='get_live_state')return {stateVersion:4};
    if(method==='set_simpler_sample_region'){writes.push(args);return structuredClone(receipt);}
    throw Error(method);
  }}});
  return {service,before,receipt,writes,args:{...target,startMarkerFrames:12000,expectedStateVersion:4}};
}
const execute=(args,plan)=>({...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});

test('sample-region plans bind exact frames and native state; omitted end preserves the observed bound',async()=>{
  const {service,before,writes,args}=fixture(),plan=await service.call('set_simpler_sample_region',args);
  assert.deepEqual(plan.plan.region,{startMarkerFrames:12000,endMarkerFrames:47999});
  assert.deepEqual(plan.plan.before,before);assert.equal(writes.length,0);
  assert.equal((await service.call('set_simpler_sample_region',execute(args,plan))).observed.verified,true);
  assert.equal(writes.length,1);
  await assert.rejects(service.call('set_simpler_sample_region',execute(args,plan)));
  assert.equal(writes.length,1);
});

test('manual sample edits with an unchanged state version invalidate the confirmation',async()=>{
  for(const change of [b=>b.sample.startMarkerFrames=1,b=>b.sample.gain=.6,b=>b.identityToken='replaced']){
    const {service,before,writes,args}=fixture(),plan=await service.call('set_simpler_sample_region',args);
    change(before);await assert.rejects(service.call('set_simpler_sample_region',execute(args,plan)));assert.equal(writes.length,0);
  }
});

test('empty, invalid, unchanged and active sample regions never reach native mutation',async()=>{
  for(const extra of [{startMarkerFrames:undefined},{startMarkerFrames:0},{startMarkerFrames:true},{startMarkerFrames:-1},
    {startMarkerFrames:47999},{startMarkerFrames:1.5},{endMarkerFrames:48000},
    {deviceId:'track-1:device-0'},{expectedStateVersion:undefined}]){
    const {service,writes,args}=fixture();await assert.rejects(service.call('set_simpler_sample_region',{...args,...extra}));assert.equal(writes.length,0);
  }
  for(const change of [b=>b.sample=null,b=>b.multiSampleMode=true,b=>b.playingPositionEnabled=true,b=>b.track.armed=true,
    b=>b.track.frozen=true,b=>b.track.monitoring=0,b=>b.track.firedSlotIndex=0,b=>b.recording.isPlaying=true,b=>b.recording.session.record=true]){
    const {service,before,writes,args}=fixture();change(before);await assert.rejects(service.call('set_simpler_sample_region',args));assert.equal(writes.length,0);
  }
});

test('a changed sample identity, path or actual region in the receipt is not verified',async()=>{
  for(const change of [r=>r.verified=false,r=>r.identityToken='other',r=>r.deviceId='track-0:device-1',
    r=>r.sample.path='/other.wav',r=>r.sample.startMarkerFrames=11999,r=>r.region.endMarkerFrames=36000,r=>r.sample.lengthFrames=96000]){
    const {service,receipt,args}=fixture(),plan=await service.call('set_simpler_sample_region',args);change(receipt);
    await assert.rejects(service.call('set_simpler_sample_region',execute(args,plan)),/readback mismatch/);
  }
});

test('sample-region mutation is guarded and confined to the all profile',async()=>{
  const {service}=fixture(),router=createRouter(service),core=createRouter(service,{toolProfile:'core'});
  const tools=(await router({id:1,method:'tools/list'})).result.tools;
  assert.equal(tools.find(t=>t.name==='set_simpler_sample_region').annotations.destructiveHint,true);
  assert.equal((await core({id:2,method:'tools/call',params:{name:'set_simpler_sample_region',arguments:{}}})).error.code,-32601);
});
