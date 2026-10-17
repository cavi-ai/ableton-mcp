import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
const target={trackId:'track-0',deviceId:'track-0:device-0'};
function fixture(){
  const before={stateVersion:4,setFingerprint:'set-a',identityToken:'sample-a',...target,
    device:{id:target.deviceId,className:'OriginalSimpler'},track:{id:'track-0',armed:false,frozen:false,monitoring:1,firedSlotIndex:-1},
    multiSampleMode:false,canEditSlices:true,playingPositionEnabled:false,playbackMode:{value:1,name:'one-shot'},parameters:[],
    nativeControls:{pad_slicing:true,slicing_playback_mode:0,retrigger:true,voices:6},
    recording:{isPlaying:false,arrangement:{record:false},session:{record:false}},
    sample:{path:'/sample.wav',lengthFrames:48000,sampleRate:48000,startMarkerFrames:0,endMarkerFrames:47999,gain:.5,warping:false,slicesFrames:[0],nativeControls:{slicing_style:0}}};
  const writes=[],sample={...before.sample,slicesFrames:[0,12000,36000],nativeControls:{slicing_style:3}},receipt={stateVersion:5,...target,verified:true,
    beforeIdentityToken:'sample-a',sampleIdentityRetained:true,sample,playbackMode:{value:2,name:'slicing'},nativeControls:{...before.nativeControls,pad_slicing:false,slicing_playback_mode:1}};
  const service=new ToolService({bridge:{request:async(method,args)=>{
    if(method==='get_simpler_sample_state')return structuredClone(before);
    if(method==='get_live_state')return {stateVersion:4};
    if(method==='set_simpler_manual_slices'){writes.push(args);return structuredClone(receipt);}
    throw Error(method);
  }}});
  return {service,before,receipt,writes,args:{...target,slicesFrames:[0,12000,36000],slicingPlaybackMode:'poly',expectedStateVersion:4}};
}
const execute=(args,plan)=>({...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});

test('manual slice plans bind sample state, exact frames and playback behavior without writing first',async()=>{
  const {service,before,writes,args}=fixture(),plan=await service.call('set_simpler_manual_slices',args);
  assert.deepEqual(plan.plan.before,before);assert.deepEqual(plan.plan.slicesFrames,[0,12000,36000]);assert.equal(plan.plan.slicingPlaybackMode,1);assert.equal(writes.length,0);
  assert.equal((await service.call('set_simpler_manual_slices',execute(args,plan))).observed.verified,true);
  await assert.rejects(service.call('set_simpler_manual_slices',execute(args,plan)));assert.equal(writes.length,1);
});

test('invalid, unsupported, unchanged or active layouts never reach native slice mutation',async()=>{
  for(const slicesFrames of [[],[1],[0,0],[0,36000,12000],[0,-1],[0,true],[0,1.5],[0,47999],Array.from({length:65},(_,i)=>i)]){
    const {service,writes,args}=fixture();await assert.rejects(service.call('set_simpler_manual_slices',{...args,slicesFrames}));assert.equal(writes.length,0);
  }
  for(const change of [b=>b.sample=null,b=>b.canEditSlices=false,b=>b.multiSampleMode=true,b=>b.track.armed=true,b=>b.track.frozen=true,
    b=>b.track.monitoring=0,b=>b.recording.isPlaying=true,b=>b.playingPositionEnabled=true,
    b=>{b.playbackMode.value=2;b.sample.slicesFrames=[0,12000,36000];b.sample.nativeControls.slicing_style=3;b.nativeControls.pad_slicing=false;b.nativeControls.slicing_playback_mode=1;}]){
    const {service,before,writes,args}=fixture();change(before);await assert.rejects(service.call('set_simpler_manual_slices',args));assert.equal(writes.length,0);
  }
});

test('same-version sample or manual slice changes invalidate the confirmation',async()=>{
  for(const change of [b=>b.sample.slicesFrames=[0,8000],b=>b.identityToken='replaced',b=>b.nativeControls.pad_slicing=false]){
    const {service,before,writes,args}=fixture(),plan=await service.call('set_simpler_manual_slices',args);change(before);
    await assert.rejects(service.call('set_simpler_manual_slices',execute(args,plan)));assert.equal(writes.length,0);
  }
});

test('mismatched native source, slice list or playback controls are never reported verified',async()=>{
  for(const change of [r=>r.verified=false,r=>r.sampleIdentityRetained=false,r=>r.beforeIdentityToken='other',r=>r.sample.path='/other.wav',
    r=>r.sample.slicesFrames=[0,12000],r=>r.sample.startMarkerFrames=10,r=>r.playbackMode.value=1,r=>r.sample.nativeControls.slicing_style=0,
    r=>r.nativeControls.pad_slicing=true,r=>r.nativeControls.slicing_playback_mode=2]){
    const {service,receipt,args}=fixture(),plan=await service.call('set_simpler_manual_slices',args);change(receipt);
    await assert.rejects(service.call('set_simpler_manual_slices',execute(args,plan)),/readback mismatch/);
  }
});

test('omitted slice playback preserves the observed choice and the tool is all-profile only',async()=>{
  const {service,args}=fixture(),input={...args,slicingPlaybackMode:undefined};
  assert.equal((await service.call('set_simpler_manual_slices',input)).plan.slicingPlaybackMode,0);
  const router=createRouter(service),core=createRouter(service,{toolProfile:'core'}),tools=(await router({id:1,method:'tools/list'})).result.tools;
  assert.equal(tools.find(t=>t.name==='set_simpler_manual_slices').annotations.destructiveHint,true);
  assert.equal((await core({id:2,method:'tools/call',params:{name:'set_simpler_manual_slices',arguments:{}}})).error.code,-32601);
  assert.ok((await service.call('get_producer_workflow',{workflow:'chop-sample-groove',arguments:{request:'Chop the selected phrase into a sparse groove.',mode:'autonomous'}})).messages.length);
});
