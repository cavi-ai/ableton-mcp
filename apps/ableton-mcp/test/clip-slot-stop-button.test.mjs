import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

const args={trackId:'track-0',clipId:'track-0:clip-0',hasStopButton:false,expectedStateVersion:4};
function fixture(){
  const before={stateVersion:4,identityToken:'native-row-a',setFingerprint:'set-a',scene:{id:'scene-0',name:'Verse'},
    tracks:[{id:'track-0',name:'Texture',isGroup:false,armed:false,frozen:false,firedSlotIndex:-1,playingClip:null,
      slot:{id:'track-0:clip-0',hasClip:false,hasStopButton:true,willRecordOnStart:false,isTriggered:false,action:'empty-stop',clip:null}}],
    recording:{arrangement:{record:false},session:{record:false}},song:{tempo:120}};
  const writes=[],receipt={stateVersion:5,trackId:'track-0',clipId:'track-0:clip-0',sceneId:'scene-0',hasStopButton:false,verified:true};
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==='get_scene_launch_context')return structuredClone(before);
    if(method==='get_live_state')return {stateVersion:4};
    if(method==='set_clip_slot_stop_button'){writes.push(params);return structuredClone(receipt);}
    throw Error(method);
  }}});
  return {service,before,writes,receipt};
}
const confirm=(plan,extra={})=>({...args,...extra,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});

test('stop-button edit plans the full row and changes only an exact empty slot through confirmation',async()=>{
  const {service,before,writes}=fixture(),plan=await service.call('set_clip_slot_stop_button',args);
  assert.deepEqual(plan.plan.before,before);assert.equal(plan.plan.sceneId,'scene-0');assert.equal(plan.plan.hasStopButton,false);
  assert.match(plan.plan.warning,/record/i);assert.equal(writes.length,0);
  const result=await service.call('set_clip_slot_stop_button',confirm(plan));
  assert.equal(result.observed.verified,true);assert.equal(result.observed.hasStopButton,false);assert.equal(writes.length,1);
  assert.deepEqual(writes[0].before,before);
  await assert.rejects(service.call('set_clip_slot_stop_button',confirm(plan)));assert.equal(writes.length,1);
});

test('manual row changes invalidate a stop-button plan even at the same version',async()=>{
  for(const change of [b=>b.identityToken='replacement',b=>b.tracks[0].armed=true,b=>b.scene.name='Other']){
    const {service,before,writes}=fixture(),plan=await service.call('set_clip_slot_stop_button',args);change(before);
    await assert.rejects(service.call('set_clip_slot_stop_button',confirm(plan)));assert.equal(writes.length,0);
  }
});

test('stop-button edits reject unsafe or unavailable slots and no-ops before confirmation',async()=>{
  for(const change of [b=>b.tracks[0].isGroup=true,b=>b.tracks[0].slot.hasClip=true,b=>b.tracks[0].frozen=true,
    b=>b.tracks[0].slot.isTriggered=true,b=>b.tracks[0].firedSlotIndex=0,b=>b.recording.session.record=true,
    b=>b.recording.arrangement.record=true,b=>b.tracks[0].playingClip={isRecording:true},
    b=>b.tracks[0].slot.hasStopButton=null,b=>b.tracks[0].slot.hasStopButton=false,
    b=>delete b.identityToken,b=>b.stateVersion=3]){
    const {service,before,writes}=fixture();change(before);
    await assert.rejects(service.call('set_clip_slot_stop_button',args));assert.equal(writes.length,0);
  }
});

test('stop-button arguments and native receipts fail closed; the writer stays outside core',async()=>{
  const {service,receipt}=fixture();
  for(const extra of [{trackId:'track-00'},{clipId:'track-1:clip-0'},{clipId:'track-0:clip-00'},{hasStopButton:0},{expectedStateVersion:undefined}])
    await assert.rejects(service.call('set_clip_slot_stop_button',{...args,...extra}));
  for(const change of [r=>r.trackId='track-1',r=>r.clipId='track-0:clip-1',r=>r.hasStopButton=true,r=>r.verified=false,r=>r.stateVersion=4]){
    const f=fixture(),plan=await f.service.call('set_clip_slot_stop_button',args);change(f.receipt);
    await assert.rejects(f.service.call('set_clip_slot_stop_button',confirm(plan)),/readback mismatch/);
  }
  const router=createRouter(service),core=createRouter(service,{toolProfile:'core'}),listed=await router({id:1,method:'tools/list'});
  assert.equal(listed.result.tools.find(t=>t.name==='set_clip_slot_stop_button').annotations.readOnlyHint,false);
  assert.equal((await core({id:2,method:'tools/call',params:{name:'set_clip_slot_stop_button',arguments:args}})).error.code,-32601);
  assert.equal((await router({id:3,method:'tools/call',params:{name:'set_clip_slot_stop_button',arguments:args}})).result.structuredContent.dryRun,true);
});
