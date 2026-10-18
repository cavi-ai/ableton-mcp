import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';

const args={trackId:'track-0',clipId:'track-0:clip-0',destinationTrackId:'track-1',destinationClipId:'track-1:clip-2',name:'Piano alternative',expectedStateVersion:4};

function fixture(){
  let identity='pair-a',targetName='Piano',receiptTrack='track-1',verified=true,writes=0;
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==='get_clip_duplication_source')return {stateVersion:4,copyGuardVersion:2,trackId:'track-0',sourceClipId:'track-0:clip-0',targetTrackId:'track-1',targetClipId:'track-1:clip-2',
      sourceTrackName:'Strings',targetTrackName:targetName,identityToken:identity,source:{name:'Chords'},target:{id:'track-1:clip-2',hasClip:false}};
    assert.equal(method,'duplicate_clip');assert.equal(params.targetTrackId,'track-1');writes++;
    return {stateVersion:5,trackId:receiptTrack,sourceTrackId:'track-0',sourceClipId:'track-0:clip-0',copiedClipId:'track-1:clip-2',copyVerified:verified,clips:[]};
  }}});
  return {service,identity:v=>identity=v,targetName:v=>targetName=v,receiptTrack:v=>receiptTrack=v,verified:v=>verified=v,writes:()=>writes};
}

test('cross-track copy confirmation binds both exact owners and the destination context',async()=>{
  const f=fixture();validateToolArguments('duplicate_clip',args);
  const plan=await f.service.call('duplicate_clip',args);assert.equal(plan.plan.targetTrackId,'track-1');assert.equal(f.writes(),0);
  const input={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  f.identity('replacement');await assert.rejects(f.service.call('duplicate_clip',input),/hash mismatch/);f.identity('pair-a');
  f.targetName('Other piano');await assert.rejects(f.service.call('duplicate_clip',input),/hash mismatch/);f.targetName('Piano');
  assert.equal((await f.service.call('duplicate_clip',input)).observed.trackId,'track-1');
  await assert.rejects(f.service.call('duplicate_clip',input));assert.equal(f.writes(),1);
});

test('copy receipts for another destination are refused',async()=>{
  for(const alter of [f=>f.receiptTrack('track-0')]){
    const f=fixture(),plan=await f.service.call('duplicate_clip',args);alter(f);
    await assert.rejects(f.service.call('duplicate_clip',{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}),/readback mismatch/);
    assert.equal(f.writes(),1);
  }
});

test('unverified copy observations remain available for reconciliation',async()=>{
  const f=fixture(),plan=await f.service.call('duplicate_clip',args);f.verified(false);
  const result=await f.service.call('duplicate_clip',{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  assert.equal(result.observed.copyVerified,false);assert.equal(f.writes(),1);
});
