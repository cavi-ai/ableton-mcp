import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

const args={trackIds:['track-0','track-1'],sourceStartBeats:16,sourceEndBeats:32,destinationStartBeats:64,repeatCount:2};
const clip=(track,index,start,end,type='midi')=>({id:`${track}:arrangement-clip-${index}`,name:'Part',startBeats:start,endBeats:end,lengthBeats:end-start,type});
function fixture(overrides={}){
  const calls=[],inventories={'track-0':[clip('track-0',0,16,24),clip('track-0',1,28,32)],'track-1':[clip('track-1',0,20,28,'audio')]};
  const bridge={request:async(name,input)=>{
    calls.push({name,input});
    if(overrides.request)return overrides.request(name,input,calls);
    if(name==='get_live_state')return {stateVersion:7,setFingerprint:'set'};
    if(name==='list_tracks')return {stateVersion:7,tracks:[{id:'track-0',name:'Chords',type:'midi',isGroup:false},{id:'track-1',name:'Drums',type:'audio',isGroup:false},...(overrides.tracks??[])]};
    if(name==='list_arrangement_clips')return {stateVersion:7,trackId:input.trackId,clips:(overrides.inventories??inventories)[input.trackId]??[]};
    throw Error('unexpected bridge write '+name);
  }};
  return {service:new ToolService({bridge}),calls};
}

test('Arrangement repeat plans preserve relative offsets, gaps and repetition length without native writes',async()=>{
  const {service,calls}=fixture(),p=await service.call('plan_arrangement_repeat',args);
  assert.equal(p.canCopy,true);assert.equal(p.atomic,false);assert.equal(p.confirmation,undefined);
  assert.deepEqual(p.destinationRange,{startBeats:64,endBeats:96});
  assert.deepEqual(p.placements.map(x=>[x.repetition,x.trackId,x.startBeats,x.endBeats]),[
    [1,'track-0',64,72],[1,'track-0',76,80],[1,'track-1',68,76],
    [2,'track-0',80,88],[2,'track-0',92,96],[2,'track-1',84,92]]);
  assert.ok(calls.every(c=>['get_live_state','list_tracks','list_arrangement_clips'].includes(c.name)));
});

test('Arrangement repeat reports boundary-crossing clips and never invents a crop',async()=>{
  const {service}=fixture({inventories:{'track-0':[clip('track-0',0,12,24)],'track-1':[]}});
  const p=await service.call('plan_arrangement_repeat',args);
  assert.equal(p.canCopy,false);assert.equal(p.boundaryClips.length,1);assert.equal(p.placements.length,0);
});

test('Arrangement repeat requires the complete destination window, including planned rests, to be empty',async()=>{
  const {service}=fixture({inventories:{'track-0':[clip('track-0',0,16,20),clip('track-0',1,70,71)],'track-1':[]}});
  const p=await service.call('plan_arrangement_repeat',args);
  assert.equal(p.canCopy,false);assert.equal(p.destinationClips[0].clipId,'track-0:arrangement-clip-1');
  assert.equal(p.placements[0].endBeats,68);
});

test('Arrangement repeat honors half-open edges and retains explicitly selected empty tracks',async()=>{
  const {service}=fixture({inventories:{'track-0':[clip('track-0',0,0,16),clip('track-0',1,16,32),clip('track-0',2,32,64),clip('track-0',3,96,100)],'track-1':[]}});
  const p=await service.call('plan_arrangement_repeat',args);
  assert.equal(p.canCopy,true);assert.equal(p.sources.length,1);assert.deepEqual(p.emptyTrackIds,['track-1']);
});

test('Arrangement repeat refuses invalid scope, Groups, malformed inventories and oversized maps',async()=>{
  for(const changed of [{trackIds:[]},{trackIds:['track-0','track-0']},{destinationStartBeats:20},{sourceEndBeats:16},{repeatCount:0},{repeatCount:17},{sourceEndBeats:1024},{destinationStartBeats:Number.MAX_SAFE_INTEGER}]){
    await assert.rejects(()=>fixture().service.call('plan_arrangement_repeat',{...args,...changed}));
  }
  await assert.rejects(()=>fixture({tracks:[{id:'track-2',type:'audio',isGroup:true}]}).service.call('plan_arrangement_repeat',{...args,trackIds:['track-2']}),/ordinary/i);
  await assert.rejects(()=>fixture({inventories:{'track-0':[clip('track-1',0,16,20)],'track-1':[]}}).service.call('plan_arrangement_repeat',args),/inventory/i);
  await assert.rejects(()=>fixture({inventories:{'track-0':Array.from({length:17},(_,i)=>clip('track-0',i,16+i*.5,16+i*.5+.25)),'track-1':[]}}).service.call('plan_arrangement_repeat',{...args,repeatCount:16}),/256/);
});

test('Arrangement repeat refuses source overlap, overlapping proposed clips and empty passages',async()=>{
  const {service}=fixture({inventories:{'track-0':[clip('track-0',0,16,24),clip('track-0',1,20,28)],'track-1':[]}});
  const p=await service.call('plan_arrangement_repeat',args);assert.equal(p.canCopy,false);assert.ok(p.plannedOverlaps.length);
  const empty=await fixture({inventories:{}}).service.call('plan_arrangement_repeat',args);assert.equal(empty.canCopy,false);assert.equal(empty.emptySource,true);
});

test('Arrangement repeat refuses an observed state change during inventory reads',async()=>{
  const {service}=fixture({request:async(name,input,calls)=>{
    if(name==='get_live_state')return {stateVersion:calls.length>1?8:7,setFingerprint:'set'};
    if(name==='list_tracks')return {stateVersion:7,tracks:[{id:'track-0',type:'midi',isGroup:false},{id:'track-1',type:'audio',isGroup:false}]};
    return {stateVersion:7,trackId:input.trackId,clips:[]};
  }});
  await assert.rejects(()=>service.call('plan_arrangement_repeat',args),/changed/);
});

test('fractional repeat boundaries match native start-plus-span arithmetic without snapping real gaps',async()=>{
  const {service}=fixture({inventories:{'track-0':[clip('track-0',0,0,1/3)],'track-1':[]}});
  const p=await service.call('plan_arrangement_repeat',{...args,sourceStartBeats:0,sourceEndBeats:1/3,destinationStartBeats:8,repeatCount:16});
  assert.equal(p.canCopy,true);
  for(let i=0;i<p.placements.length;i++){
    assert.equal(p.placements[i].endBeats,p.placements[i].startBeats+1/3);
    if(i)assert.equal(p.placements[i].startBeats,p.placements[i-1].endBeats);
  }
  const gaps=fixture({inventories:{'track-0':[clip('track-0',0,0,.1),clip('track-0',1,.100001,.2)],'track-1':[]}});
  const spaced=await gaps.service.call('plan_arrangement_repeat',{...args,sourceStartBeats:0,sourceEndBeats:.2,destinationStartBeats:8});
  assert.equal(spaced.canCopy,true);assert.ok(spaced.placements[1].startBeats>spaced.placements[0].endBeats);
});

test('Arrangement repeat discovery is all-profile read-only while workflow retrieval remains inert',async()=>{
  const {service,calls}=fixture(),route=createRouter(service,{toolProfile:'all'});
  const discovery=await route({id:1,method:'tools/list'});
  const tool=discovery.result.tools.find(x=>x.name==='plan_arrangement_repeat');
  assert.equal(tool.annotations.readOnlyHint,true);
  const core=await createRouter(service,{toolProfile:'core'})({id:2,method:'tools/list'});assert.ok(!core.result.tools.some(x=>x.name==='plan_arrangement_repeat'));
  const callsBefore=calls.length;
  const workflow=await route({id:3,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'repeat-arrangement-section',arguments:{request:'Repeat the chorus twice at beat 64'}}}});
  assert.ok(workflow.result.structuredContent.messages[0].content.text.includes('plan_arrangement_repeat'));
  assert.equal(calls.length,callsBefore);
  assert.throws(()=>getPrompt('repeat-arrangement-section',{request:'Repeat',mode:'overwrite'}),/mode/);
});
