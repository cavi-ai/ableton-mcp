import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

function fixture(){
 const before={stateVersion:4,identityToken:'return-owner',trackIds:['return-0'],fields:['mute'],readyToChange:true,reasons:[],
  tracks:[{trackId:'return-0',name:'Reverb',mute:false,solo:false,sends:[]}]};
 let writes=0;
 const receipt={stateVersion:5,returnTrackId:'return-0',return:{id:'return-0',mute:true},writeRequested:true,nativeReturned:false,verified:false,error:'setter failed after applying'};
 const service=new ToolService({bridge:{async request(method,params){
  if(method==='get_return_mixer_edit_context'){assert.deepEqual(params,{returnTrackId:'return-0',fields:['mute']});return structuredClone(before);}
  assert.equal(method,'set_return_mixer');assert.deepEqual(params.before,before);writes++;return receipt;
 }}});
 return {service,before,receipt,writes:()=>writes,args:{returnTrackId:'return-0',mute:true,expectedStateVersion:4}};
}

test('Return confirmation binds native identity and preserves partial facts without retry',async()=>{
 const f=fixture(),plan=await f.service.call('set_return_mixer',f.args);
 const confirmed={...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 f.before.identityToken='replacement';await assert.rejects(f.service.call('set_return_mixer',confirmed),/changed|mismatch/);assert.equal(f.writes(),0);
 f.before.identityToken='return-owner';const result=await f.service.call('set_return_mixer',confirmed);
 assert.deepEqual(result.observed,f.receipt);await assert.rejects(f.service.call('set_return_mixer',confirmed));assert.equal(f.writes(),1);
});

test('Return plans refuse missing or unsafe context and noncanonical scope',async()=>{
 for(const alter of [x=>delete x.identityToken,x=>x.readyToChange=false,x=>x.tracks[0].trackId='return-1']){
  const f=fixture();alter(f.before);await assert.rejects(f.service.call('set_return_mixer',f.args));assert.equal(f.writes(),0);
 }
 const f=fixture();for(const args of [{mute:1},{returnTrackId:'return-00'},{returnTrackId:'track-0'},{mute:undefined}])
  await assert.rejects(f.service.call('set_return_mixer',{...f.args,...args}));
 assert.equal(f.writes(),0);
});
