import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

function fixture(){
 const target={trackId:'track-0',clipId:'track-0:clip-0'},before={stateVersion:4,...target,identityToken:'native',markersSupported:true,
  notes:[{noteId:7,pitch:60,start:0,duration:1,velocity:90}],clipTiming:{loop:{enabled:true},markers:{supported:true,unit:'beats',startBeats:0,endBeats:4}},
  editContext:Object.fromEntries(['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'].map(k=>[k,false]))};
 const calls=[],service=new ToolService({bridge:{async request(method,args){calls.push({method,args});
  if(method==='get_midi_clip_marker_context')return structuredClone(before);
  if(method==='set_midi_clip_markers')return {stateVersion:5,...target,writeRequested:true,nativeReturned:false,markersVerified:false,error:'setter interrupted',observed:{...before,clipTiming:{markers:{supported:true,unit:'beats',startBeats:1,endBeats:4}}}};
  throw Error(method);
 }}});
 return {before,calls,service,args:{...target,expectedStateVersion:4,startBeats:1,endBeats:3}};
}
test('marker plans retain omitted bounds and partial native readback',async()=>{
 const f=fixture(),{endBeats,...one}=f.args,p=await f.service.call('set_midi_clip_markers',one);
 assert.deepEqual(p.plan.markers,{startBeats:1,endBeats:4});assert.equal(f.calls.length,1);
 const result=await f.service.call('set_midi_clip_markers',{...one,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
 assert.equal(result.observed.markersVerified,false);assert.match(result.observed.error,/interrupted/);assert.equal(f.calls.filter(c=>c.method==='set_midi_clip_markers').length,1);
});
test('same-version native replacement and content changes refuse confirmation',async()=>{
 for(const change of [c=>c.identityToken='new',c=>c.notes[0].velocity=31,c=>c.clipTiming.markers.endBeats=5]){
  const f=fixture(),p=await f.service.call('set_midi_clip_markers',f.args);change(f.before);
  await assert.rejects(f.service.call('set_midi_clip_markers',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.calls.some(c=>c.method==='set_midi_clip_markers'),false);
 }
});
test('missing limits unsupported unknown and recording contexts refuse',async()=>{
 const f=fixture();await assert.rejects(f.service.call('set_midi_clip_markers',{trackId:'track-0',clipId:'track-0:clip-0',expectedStateVersion:4}));assert.equal(f.calls.length,0);
 for(const change of [c=>c.markersSupported=false,c=>c.identityToken='',c=>c.editContext.pendingLaunch=true,c=>delete c.editContext.countingIn]){
  const f=fixture();change(f.before);await assert.rejects(f.service.call('set_midi_clip_markers',f.args));assert.equal(f.calls.some(c=>c.method==='set_midi_clip_markers'),false);
 }
});
test('nonlooped marker plans refuse before a native write',async()=>{
 const f=fixture();f.before.clipTiming.loop.enabled=false;
 await assert.rejects(f.service.call('set_midi_clip_markers',f.args),/loop-enabled/);
 assert.deepEqual(f.calls.map(c=>c.method),['get_midi_clip_marker_context']);
});
test('marker writer is all-profile and refuses wrong units at the MCP boundary',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 const tools=await all({id:1,method:'tools/list'}),tool=tools.result.tools.find(t=>t.name==='set_midi_clip_markers');assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,false);
 assert.equal((await core({id:2,method:'tools/call',params:{name:'set_midi_clip_markers',arguments:f.args}})).error.code,-32601);
 assert.equal((await all({id:3,method:'tools/call',params:{name:'set_midi_clip_markers',arguments:{...f.args,startSeconds:2}}})).error.code,-32602);
});
test('phrase workflow retrieval makes no Live call and refuses unsupported modes',async()=>{
 const f=fixture(),result=await f.service.call('get_producer_workflow',{workflow:'set-midi-phrase-bounds',arguments:{request:'Try a shorter ending'}});
 assert.ok(result.messages.length);
 await assert.rejects(f.service.call('get_producer_workflow',{workflow:'set-midi-phrase-bounds',arguments:{request:'Try a shorter ending',mode:'replace'}}),/mode/);
 assert.equal(f.calls.length,0);
});
