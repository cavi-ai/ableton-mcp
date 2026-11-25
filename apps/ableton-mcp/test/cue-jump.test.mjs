import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

test('locator jump binds the current native context and consumes a partial request once',async()=>{
 let identityToken='original',writes=0;
 const args={cuePointId:'cue-0',expectedStateVersion:4};
 const service=new ToolService({bridge:{request:async(method)=>{
  if(method==='get_arrangement_cue_jump_context')return {stateVersion:4,cuePointId:'cue-0',identityToken,cuePoint:{id:'cue-0',name:'Chorus',timeBeats:16}};
  assert.equal(method,'jump_to_arrangement_cue_point');writes++;
  return {jumpRequested:true,nativeReturned:false,positionVerified:false,error:'uncertain native jump'};
 }}});
 const dry=await service.call('jump_to_arrangement_cue_point',args);assert.equal(writes,0);assert.equal(dry.plan.before.cuePoint.name,'Chorus');
 const confirmed={...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};
 identityToken='replacement';await assert.rejects(service.call('jump_to_arrangement_cue_point',confirmed),/changed|mismatch/);identityToken='original';
 assert.equal((await service.call('jump_to_arrangement_cue_point',confirmed)).observed.nativeReturned,false);
 await assert.rejects(service.call('jump_to_arrangement_cue_point',confirmed));assert.equal(writes,1);
});