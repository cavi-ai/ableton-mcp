import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

function fixture(){
 const before={stateVersion:4,identityToken:'main-owner',fields:['volume'],readyToChange:true,reasons:[],
  master:{volume:{value:.8,min:0,max:1},outputRouting:{supported:true,channel:{id:'1/2',name:'1/2'},availableChannels:[{id:'1/2',name:'1/2'}]}}};
 let writes=0;
 const receipt={stateVersion:5,master:{volume:{value:.4}},returns:[],writeRequested:true,nativeReturned:false,verified:false,error:'setter failed after applying'};
 const service=new ToolService({bridge:{async request(method,params){
  if(method==='get_master_mixer_edit_context'){assert.deepEqual(params,{fields:['volume']});return structuredClone(before);}
  assert.equal(method,'set_master_mixer');assert.deepEqual(params.before,before);writes++;return receipt;
 }}});
 return {service,before,receipt,writes:()=>writes,args:{volume:.4,expectedStateVersion:4}};
}

test('Main confirmation binds native context and retains partial facts exactly once',async()=>{
 const f=fixture(),plan=await f.service.call('set_master_mixer',f.args);
 const confirmed={...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 f.before.identityToken='replacement';await assert.rejects(f.service.call('set_master_mixer',confirmed),/changed|mismatch/);assert.equal(f.writes(),0);
 f.before.identityToken='main-owner';const result=await f.service.call('set_master_mixer',confirmed);
 assert.deepEqual(result.observed,f.receipt);await assert.rejects(f.service.call('set_master_mixer',confirmed));assert.equal(f.writes(),1);
});

test('Main refuses missing identity, unsafe readiness or wrong native scope',async()=>{
 for(const alter of [x=>delete x.identityToken,x=>x.readyToChange=false,x=>x.fields=['pan'],x=>delete x.master]){
  const f=fixture();alter(f.before);await assert.rejects(f.service.call('set_master_mixer',f.args));assert.equal(f.writes(),0);
 }
 const f=fixture();await assert.rejects(f.service.call('set_master_mixer',{expectedStateVersion:4}),/at least one/);
});

test('Main refuses duplicate output IDs before issuing a confirmation',async()=>{
 const a={id:'1/2',name:'1/2'},b={id:'3/4',name:'3/4'};
 const service=new ToolService({bridge:{async request(method){
  assert.equal(method,'get_master_mixer_edit_context');
  return {stateVersion:4,identityToken:'main',fields:['outputChannelId'],readyToChange:true,
   master:{outputRouting:{supported:true,channel:a,availableChannels:[a,b,{...b}]}}};
 }}});
 await assert.rejects(service.call('set_master_mixer',{expectedStateVersion:4,outputChannelId:'3/4'}),/ambiguous/);
});
