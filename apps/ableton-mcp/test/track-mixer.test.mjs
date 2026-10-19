import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

function fixture(bulk=false){
 const ids=bulk?['track-0','track-1']:['track-0'];
 const before={stateVersion:4,identityToken:'owner',trackIds:ids,readyToChange:true,reasons:[],tracks:ids.map(trackId=>({trackId,mute:false,solo:false,sends:[]}))};
 let writes=0;
 const service=new ToolService({bridge:{async request(method,params){
  if(method==='get_track_mixer_edit_context'){assert.deepEqual(params.trackIds,ids);assert.deepEqual(params.fields,['mute']);return structuredClone(before);}
  assert.equal(method,bulk?'set_bulk_track_mixer':'set_track_mixer');writes++;
  assert.deepEqual(params.before,before);return {stateVersion:5,writeRequested:true,nativeReturned:false,verified:false,mute:true,error:'setter failed after applying',writes:[{trackId:'track-0',field:'mute',nativeReturned:false}]};
 }}});
 return {service,before,writes:()=>writes,name:bulk?'set_bulk_track_mixer':'set_track_mixer',args:{...(bulk?{trackIds:ids}:{trackId:ids[0]}),mute:true,expectedStateVersion:4}};
}

test('single and bulk mixer confirmations retain native context and partial outcomes once',async()=>{
 for(const bulk of [false,true]){
  const f=fixture(bulk),p=await f.service.call(f.name,f.args);
  const confirmed={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
  f.before.identityToken='replacement';await assert.rejects(f.service.call(f.name,confirmed),/changed|mismatch/);
  f.before.identityToken='owner';const r=await f.service.call(f.name,confirmed);assert.equal(r.observed.verified,false);assert.equal(r.observed.mute,true);
  await assert.rejects(f.service.call(f.name,confirmed));assert.equal(f.writes(),1);
 }
});

test('mixer rejects unsafe or absent native context and coerced boolean controls',async()=>{
 for(const bulk of [false,true])for(const alter of [c=>delete c.identityToken,c=>c.readyToChange=false,c=>c.tracks[0].trackId='track-9']){
  const f=fixture(bulk);alter(f.before);await assert.rejects(f.service.call(f.name,f.args));assert.equal(f.writes(),0);
 }
 const f=fixture(true);await assert.rejects(f.service.call(f.name,{...f.args,mute:1}),/boolean/);
});
