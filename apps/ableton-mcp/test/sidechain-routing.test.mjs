import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

function fixture(){
 const before={stateVersion:4,trackId:'track-0',deviceId:'track-0:device-0',identityToken:'owner',recordingOff:true,launchesClear:true,frozen:false,
  sidechain:{supported:true,type:{id:'none',name:'No Input'},channel:{id:'pre',name:'Pre FX'},availableTypes:[{id:'source',name:'Trigger'}],availableChannels:[{id:'pre',name:'Pre FX'}]}};
 let writes=0;
 const service=new ToolService({bridge:{async request(method,params){
  if(method==='get_device_sidechain_edit_context')return structuredClone(before);
  assert.equal(method,'set_device_sidechain_routing');assert.deepEqual(params.before,before);writes++;
  return {stateVersion:5,writeRequested:true,nativeReturned:false,verified:false,error:'setter failed after applying',sidechain:{type:{id:'source',name:'Trigger'}}};
 }}});
 return {before,service,writes:()=>writes,args:{trackId:'track-0',deviceId:'track-0:device-0',expectedStateVersion:4,sourceTypeId:'source'}};
}

test('sidechain confirmation binds native ownership and preserves a partial receipt once',async()=>{
 const f=fixture(),p=await f.service.call('set_device_sidechain_routing',f.args);
 assert.deepEqual(p.plan.before,f.before);assert.equal(f.writes(),0);
 const confirmed={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 f.before.identityToken='replacement';await assert.rejects(f.service.call('set_device_sidechain_routing',confirmed),/changed|mismatch/);
 f.before.identityToken='owner';const r=await f.service.call('set_device_sidechain_routing',confirmed);
 assert.equal(r.observed.verified,false);assert.equal(r.observed.nativeReturned,false);assert.equal(r.observed.sidechain.type.id,'source');
 await assert.rejects(f.service.call('set_device_sidechain_routing',confirmed));assert.equal(f.writes(),1);
});

test('sidechain rejects absent native support, unsafe context and another device before planning',async()=>{
 for(const alter of [c=>delete c.identityToken,c=>c.recordingOff=false,c=>c.launchesClear=false,c=>c.frozen=null,c=>c.deviceId='track-0:device-1']){
  const f=fixture();alter(f.before);await assert.rejects(f.service.call('set_device_sidechain_routing',f.args));assert.equal(f.writes(),0);
 }
});
