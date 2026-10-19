import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

function fixture() {
 const context={stateVersion:4,trackId:'track-0',identityToken:'owner',recordingOff:true,launchesClear:true,
  target:{isGroup:false,isFrozen:false},armStates:[{armed:false,implicitArm:false}],
  input:{type:{id:'all',name:'All Ins'},channel:{id:'all',name:'All Channels'},availableTypes:[{id:'all',name:'All Ins'}],availableChannels:[{id:'all',name:'All Channels'}]},
  output:{type:{id:'main',name:'Main'},channel:{id:'stereo',name:'1/2'},availableTypes:[{id:'main',name:'Main'},{id:'none',name:'No Output'}],availableChannels:[{id:'stereo',name:'1/2'}]},
  monitoring:{name:'auto',value:1,choices:[{name:'auto',value:1},{name:'off',value:2}]}};
 let writes=0;
 const service=new ToolService({bridge:{async request(method,params){
  assert.ok(['get_track_routing_edit_context','set_track_routing'].includes(method));
  if(method==='get_track_routing_edit_context') return structuredClone(context);
  writes++;assert.equal(params.before.identityToken,'owner');
  return {stateVersion:5,trackId:'track-0',verified:false,writeRequested:true,nativeReturned:false,error:'setter failed after applying',writes:[{field:'outputTypeId',writeRequested:true,nativeReturned:false}]};
 }}});
 return {context,service,writes:()=>writes,args:{trackId:'track-0',expectedStateVersion:4,outputTypeId:'none'}};
}

test('routing confirmation binds native context and preserves partial writes without retry',async()=>{
 const f=fixture(),dry=await f.service.call('set_track_routing',f.args);
 assert.deepEqual(dry.plan.before,f.context);assert.equal(f.writes(),0);
 f.context.identityToken='replacement';
 const confirmed={...f.args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};
 await assert.rejects(f.service.call('set_track_routing',confirmed),/changed|mismatch/);
 f.context.identityToken='owner';
 const result=await f.service.call('set_track_routing',confirmed);
 assert.equal(result.observed.verified,false);assert.equal(result.observed.nativeReturned,false);
 await assert.rejects(f.service.call('set_track_routing',confirmed));assert.equal(f.writes(),1);
});

test('routing refuses missing native support, unsafe readiness and ambiguous IDs',async()=>{
 for(const alter of [c=>delete c.identityToken,c=>c.recordingOff=false,c=>c.launchesClear=false,
  c=>c.trackId='track-1',c=>c.output.availableTypes.push(c.output.availableTypes[1])]){
  const f=fixture();alter(f.context);await assert.rejects(f.service.call('set_track_routing',f.args));assert.equal(f.writes(),0);
 }
 const f=fixture();f.context.armStates[0].armed=true;
 await assert.rejects(f.service.call('set_track_routing',{...f.args,monitoring:'off'}),/disarmed/);
 const dry=await f.service.call('set_track_routing',f.args);assert.equal(dry.dryRun,true);
});
