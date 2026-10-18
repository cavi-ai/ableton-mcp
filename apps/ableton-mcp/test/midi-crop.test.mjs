import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

function fixture(){
 const target={trackId:'track-0',clipId:'track-0:clip-0'},before={stateVersion:4,...target,identityToken:'native',cropSupported:true,
  selectedRegion:{fromLoop:true,startBeats:2,endBeats:6},notes:[{noteId:7,pitch:60,start:3,duration:1,velocity:90}],clipTiming:{},
  editContext:Object.fromEntries(['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'].map(k=>[k,false]))};
 const calls=[],service=new ToolService({bridge:{async request(method,args){calls.push({method,args});
  if(method==='get_midi_crop_context')return structuredClone(before);
  if(method==='crop_midi_clip')return {stateVersion:5,...target,writeRequested:true,nativeReturned:false,readbackAvailable:true,error:'native interrupted',observed:{...before,notes:[]}};
  throw Error(method);
 }}});
 return {before,calls,service,args:{...target,expectedStateVersion:4}};
}
test('crop plans the observed interval and retains actual partial results',async()=>{
 const f=fixture(),p=await f.service.call('crop_midi_clip',f.args);
 assert.deepEqual(p.plan.before,f.before);assert.equal(f.calls.length,1);
 const result=await f.service.call('crop_midi_clip',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
 assert.equal(result.observed.nativeReturned,false);assert.match(result.observed.error,/interrupted/);assert.deepEqual(result.observed.observed.notes,[]);
 assert.equal(f.calls.filter(c=>c.method==='crop_midi_clip').length,1);
});
test('same-version note timing or native replacement invalidates confirmation',async()=>{
 for(const change of [c=>c.identityToken='new',c=>c.notes[0].velocity=31,c=>c.selectedRegion.endBeats=5]){
  const f=fixture(),p=await f.service.call('crop_midi_clip',f.args);change(f.before);
  await assert.rejects(f.service.call('crop_midi_clip',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.calls.some(c=>c.method==='crop_midi_clip'),false);
 }
});
test('unsupported unknown and active recording contexts refuse before crop',async()=>{
 for(const change of [c=>c.cropSupported=false,c=>c.identityToken='',c=>c.editContext.pendingLaunch=true,c=>delete c.editContext.countingIn,c=>c.selectedRegion.endBeats=2]){
  const f=fixture();change(f.before);await assert.rejects(f.service.call('crop_midi_clip',f.args));
  assert.equal(f.calls.some(c=>c.method==='crop_midi_clip'),false);
 }
});
test('crop is an all-profile destructive writer and rejects invented crop limits',async()=>{
 const f=fixture(),all=createRouter(f.service,{toolProfile:'all'}),core=createRouter(f.service,{toolProfile:'core'});
 const tools=await all({id:1,method:'tools/list'}),crop=tools.result.tools.find(t=>t.name==='crop_midi_clip');assert.ok(crop);assert.equal(crop.annotations.readOnlyHint,false);assert.equal(crop.annotations.destructiveHint,true);
 assert.equal((await core({id:2,method:'tools/call',params:{name:'crop_midi_clip',arguments:f.args}})).error.code,-32601);
 assert.equal((await all({id:3,method:'tools/call',params:{name:'crop_midi_clip',arguments:{...f.args,startBeats:0}}})).error.code,-32602);
});
test('workflow retrieval executes nothing and rejects unsupported crop modes',async()=>{
 const f=fixture(),result=await f.service.call('get_producer_workflow',{workflow:'crop-midi-phrase',arguments:{request:'Keep the loop on a copy'}});
 assert.ok(result.messages.length);
 await assert.rejects(f.service.call('get_producer_workflow',{workflow:'crop-midi-phrase',arguments:{request:'Keep the loop',mode:'replace'}}),/mode/);
 assert.equal(f.calls.length,0);
});
