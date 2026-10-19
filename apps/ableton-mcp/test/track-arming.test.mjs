import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

function fixture(){
 const context={stateVersion:4,trackId:'track-0',identityToken:'native-owner',readyToChange:true,reasons:[],
   target:{id:'track-0',name:'Bass',armed:false,canBeArmed:true,implicitArm:false},armStates:[{id:'track-0',armed:false}]};
 let writes=0;
 const service=new ToolService({bridge:{async request(method,params){
  if(method==='get_track_arm_context')return structuredClone(context);
  assert.equal(method,'arm_track');writes++;
  assert.equal(params.before.identityToken,'native-owner');
  return {stateVersion:5,trackId:'track-0',armed:true,writeRequested:true,nativeReturned:false,verified:false,error:'setter failed after applying'};
 }}});
 return {context,service,args:{trackId:'track-0',armed:true,expectedStateVersion:4},writes:()=>writes};
}

test('arming confirmation binds the native target and preserves a partial receipt once',async()=>{
 const f=fixture(),p=await f.service.call('arm_track',f.args);
 assert.equal(f.writes(),0);assert.deepEqual(p.plan.before,f.context);
 f.context.identityToken='replacement';
 await assert.rejects(f.service.call('arm_track',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}),/changed|mismatch/);
 f.context.identityToken='native-owner';
 const confirmed={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 const r=await f.service.call('arm_track',confirmed);
 assert.equal(r.observed.armed,true);assert.equal(r.observed.nativeReturned,false);assert.equal(r.observed.verified,false);
 await assert.rejects(f.service.call('arm_track',confirmed));assert.equal(f.writes(),1);
});

test('arming refuses ineligible and outdated contexts and nonboolean values before writing',async()=>{
 for(const alter of [c=>delete c.identityToken,c=>c.trackId='track-1',c=>{c.readyToChange=false;c.reasons=['recording'];}]){
  const f=fixture();alter(f.context);await assert.rejects(f.service.call('arm_track',f.args));assert.equal(f.writes(),0);
 }
 const f=fixture();await assert.rejects(f.service.call('arm_track',{...f.args,armed:1}),/boolean/);assert.equal(f.writes(),0);
});

test('track arm readiness is discoverable in all while arming remains in core',async()=>{
 const service=fixture().service;
 const all=createRouter(service,{toolProfile:'all'}),core=createRouter(service,{toolProfile:'core'});
 const names=async r=>(await r({id:1,method:'tools/list'})).result.tools.map(t=>t.name);
 assert.ok((await names(all)).includes('get_track_arm_context'));
 assert.ok(!(await names(core)).includes('get_track_arm_context'));
 assert.ok((await names(core)).includes('arm_track'));
 const r=await service.call('get_track_arm_context',{trackId:'track-0'});assert.equal(r.target.name,'Bass');
});
