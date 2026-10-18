import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

test('absolute seek confirmation tolerates a moving clock and preserves a partial receipt once',async()=>{
 const context={stateVersion:4,identityToken:'song',transport:{isPlaying:true,arrangement:{record:false},session:{record:false}}};
 let writes=0;
 const service=new ToolService({bridge:{request:async(method,params)=>{
  if(method==='get_transport_seek_context')return structuredClone(context);
  assert.equal(method,'set_transport_recording_context');writes++;
  return {stateVersion:5,nativeReturned:false,seek:{writeRequested:true,nativeReturned:true},observed:{currentSongTime:33,isPlaying:true},verification:{controlsConfirmed:false,positionVerified:false,unverifiedFields:['currentSongTime']},error:'later write failed'};
 }}});
 const args={expectedStateVersion:4,currentSongTime:32,automationArm:false};
 const dry=await service.call('set_transport_recording_context',args);assert.equal(writes,0);
 context.identityToken='replacement';await assert.rejects(service.call('set_transport_recording_context',{...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash}),/changed|mismatch/);
 context.identityToken='song';const confirmed={...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};
 const result=await service.call('set_transport_recording_context',confirmed);assert.equal(result.seekReceipt.seek.nativeReturned,true);assert.equal(result.verification.positionVerified,false);
 await assert.rejects(service.call('set_transport_recording_context',confirmed));assert.equal(writes,1);
});

test('seeks require an updated exact native Set identity before planning',async()=>{
 const service=new ToolService({bridge:{request:async()=>({stateVersion:4,transport:{isPlaying:true}})}});
 await assert.rejects(service.call('set_transport_recording_context',{expectedStateVersion:4,currentSongTime:8}),/identity|updated/);
});
