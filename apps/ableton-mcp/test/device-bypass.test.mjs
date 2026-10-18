import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {toolContracts} from '../src/tool-contracts.mjs';

function fixture(){
 const before={stateVersion:4,trackId:'track-0',deviceId:'track-0:device-0',identityToken:'native',supported:true,
  device:{id:'track-0:device-0',name:'EQ Eight',className:'Eq8',active:true},localActive:true,effectiveActive:true};
 let writes=0;
 const service=new ToolService({bridge:{async request(method){
  if(['get_device_activation_context','get_device_activation_edit_context'].includes(method))return structuredClone(before);
  if(method==='set_device_active'){writes++;return {verified:false,nativeReturned:true,error:'readback mismatch',device:before.device};}
  throw Error(method);
 }}});
 return {before,service,args:{trackId:'track-0',deviceId:'track-0:device-0',expectedStateVersion:4,active:false},writes:()=>writes};
}
test('activation context planning is inert and partial native receipt is preserved',async()=>{
 const f=fixture(),plan=await f.service.call('set_device_active',f.args);
 assert.equal(f.writes(),0);assert.deepEqual(plan.plan.before,f.before);
 const args={...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 const result=await f.service.call('set_device_active',args);
 assert.equal(result.observed.verified,false);assert.equal(f.writes(),1);
 await assert.rejects(f.service.call('set_device_active',args));assert.equal(f.writes(),1);
});
test('same-version native replacement and manual power change refuse old plans',async()=>{
 for(const change of [f=>f.before.identityToken='replacement',f=>f.before.localActive=false]){
  const f=fixture(),p=await f.service.call('set_device_active',f.args);change(f);
  await assert.rejects(f.service.call('set_device_active',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.writes(),0);
 }
});
test('activation context is read-only and excluded from core',async()=>{
 assert.equal(toolContracts.get_device_activation_context.annotations.readOnlyHint,true);
 assert.equal(toolContracts.get_device_activation_context.annotations.idempotentHint,true);
 const f=fixture(),route=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 const params={name:'get_device_activation_context',arguments:{trackId:'track-0',deviceId:'track-0:device-0'}};
 assert.equal((await route({id:1,method:'tools/call',params})).result.structuredContent.localActive,true);
 assert.equal((await core({id:2,method:'tools/call',params})).error.code,-32601);
 assert.equal(f.writes(),0);
});
