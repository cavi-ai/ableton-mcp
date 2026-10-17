import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
const target={trackId:'track-0',deviceId:'track-0:device-0',destinationTrackId:'track-1',destinationClipId:'track-1:clip-0'};
function fixture(){
  const before={stateVersion:4,...target,identityToken:'native-a',canExport:true,loopLength:8,tempo:120,
    state:'Stop',parameters:[],sourceFrozen:false,recording:{arrangement:false,session:false},
    destination:{hasClip:false,audioTrack:true,frozen:false,armed:false,firedSlotIndex:-1,isTriggered:false},bufferContentAvailable:false};
  const writes=[],receipt={stateVersion:5,...target,exportRequested:true,clipCreatedVerified:true,bufferContentVerified:false};
  const service=new ToolService({bridge:{async request(method,args){
    if(method==='get_looper_export_context')return structuredClone(before);
    if(method==='export_looper_clip'){writes.push(args);return structuredClone(receipt);}
    throw Error(method);
  }}});
  return {before,writes,receipt,service,args:{...target,expectedStateVersion:4,name:'Kept loop'}};
}
const execute=(args,plan)=>({...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
test('Looper export read is inert and export binds native context with a single-use confirmation',async()=>{
  const {service,before,writes,args}=fixture();assert.deepEqual(await service.call('get_looper_export_context',target),before);
  const plan=await service.call('export_looper_clip',args);assert.deepEqual(plan.plan.before,before);assert.equal(writes.length,0);
  const result=await service.call('export_looper_clip',execute(args,plan));assert.equal(result.observed.clipCreatedVerified,true);assert.equal(writes.length,1);
  await assert.rejects(service.call('export_looper_clip',execute(args,plan)));assert.equal(writes.length,1);
});
test('Looper export refuses stale native context and unsafe or unsupported destinations',async()=>{
  for(const change of [b=>b.canExport=false,b=>b.loopLength=0,b=>b.state='Overdub',b=>b.sourceFrozen=true,
    b=>b.destination.hasClip=true,b=>b.destination.audioTrack=false,b=>b.destination.armed=true,
    b=>b.destination.frozen=true,b=>b.destination.isTriggered=true,b=>b.destination.firedSlotIndex=0,b=>b.recording.session=true]){
    const {service,before,writes,args}=fixture();change(before);await assert.rejects(service.call('export_looper_clip',args));assert.equal(writes.length,0);
  }
  const {service,before,writes,args}=fixture(),plan=await service.call('export_looper_clip',args);before.identityToken='replacement';
  await assert.rejects(service.call('export_looper_clip',execute(args,plan)));assert.equal(writes.length,0);
});
test('Looper export exposes conservative partial receipts and all-profile workflow discovery',async()=>{
  const {service,receipt,args}=fixture(),plan=await service.call('export_looper_clip',args);
  receipt.clipCreatedVerified=false;receipt.verificationError='Inspect the destination before retrying';
  assert.equal((await service.call('export_looper_clip',execute(args,plan))).observed.clipCreatedVerified,false);
  const router=createRouter(service),listed=(await router({id:1,method:'tools/list'})).result.tools;
  assert.equal(listed.find(t=>t.name==='get_looper_export_context').annotations.readOnlyHint,true);
  assert.equal(listed.find(t=>t.name==='export_looper_clip').annotations.destructiveHint,true);
  const prompt=await service.call('get_producer_workflow',{workflow:'keep-looper-performance',arguments:{request:'Keep the current loop as a Session clip'}});
  assert.match(prompt.messages[0].content.text,/export_looper_clip/);
  assert.match(prompt.messages[0].content.text,/bufferContentVerified/);
});
