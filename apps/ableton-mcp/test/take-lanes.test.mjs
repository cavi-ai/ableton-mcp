import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
const target={trackId:'track-0',takeClipId:'track-0:take-lane-0:clip-0'};
function fixture(){
 const before={stateVersion:4,...target,identityToken:'take-a',supported:true,takePromotionSupported:false,lanes:[],
  track:{frozen:false,armed:false,firedSlotIndex:-1},recording:{isPlaying:false,arrangement:false,session:false},
  selected:{id:target.takeClipId,startBeats:4,endBeats:8,recording:false,content:{name:'Take',notes:[]}},arrangement:[]};
 const requests=[],service=new ToolService({bridge:{async request(method,args){
  requests.push({method,args});assert.equal(method,'get_take_lane_context');return structuredClone(before);
 }}});return {before,requests,service};
}
test('take read returns selected native material without invoking any mutation',async()=>{
 const {service,before,requests}=fixture();assert.deepEqual(await service.call('get_take_lane_context',target),before);
 assert.deepEqual(requests,[{method:'get_take_lane_context',args:target}]);
 await assert.rejects(service.call('copy_take_lane_clip',{...target,startBeats:20,expectedStateVersion:4}),/unknown tool/);
 assert.equal(requests.length,1);
});
test('take read refuses ambiguous references and mismatched native context',async()=>{
 for(const change of [b=>b.trackId='track-1',b=>b.selected.id='track-0:take-lane-1:clip-0',b=>b.identityToken='',b=>b.lanes=Array(129).fill({})]){
  const {before,service}=fixture();change(before);await assert.rejects(service.call('get_take_lane_context',target));
 }
 const {service,requests}=fixture();await assert.rejects(service.call('get_take_lane_context',{...target,takeClipId:'track-0:take-lane-00:clip-0'}));assert.equal(requests.length,0);
});
test('take inspection is read-only, all-profile and discoverable through workflow catalog',async()=>{
 const {service}=fixture(),listed=(await createRouter(service)({id:1,method:'tools/list'})).result.tools;
 assert.equal(listed.find(t=>t.name==='get_take_lane_context').annotations.readOnlyHint,true);
 assert.equal(listed.find(t=>t.name==='copy_take_lane_clip'),undefined);
 const core=createRouter(service,{toolProfile:'core'});assert.equal((await core({id:2,method:'tools/call',params:{name:'get_take_lane_context',arguments:target}})).error.code,-32601);
 const workflow=await service.call('get_producer_workflow',{workflow:'inspect-recorded-takes',arguments:{request:'Inspect alternate performances'}});assert.ok(workflow.messages.length);
});
