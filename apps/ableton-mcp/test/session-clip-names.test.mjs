import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

test('Session rename binds native clip context and preserves a partial receipt once',async()=>{
  let identity='original',name='Idea',writes=0;
  const args={trackId:'track-0',targetType:'clip',targetId:'track-0:clip-0',name:'Verse',expectedStateVersion:4};
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==='get_session_clip_name_context')return {stateVersion:4,trackId:'track-0',clipId:'track-0:clip-0',identityToken:identity,clip:{id:'track-0:clip-0',name,hasClip:true}};
    assert.equal(method,'rename_session_object');assert.equal(params.before.identityToken,identity);writes++;
    return {verified:false,nativeReturned:true,observed:{clip:{name:'Verse'}},error:'undo end failed'};
  }}});
  const dry=await service.call('rename_session_object',args);assert.equal(writes,0);assert.equal(dry.plan.target.previousName,'Idea');
  const confirmed={...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};
  identity='replacement';await assert.rejects(service.call('rename_session_object',confirmed),/changed|mismatch/);identity='original';
  name='Manual label';await assert.rejects(service.call('rename_session_object',confirmed),/changed|mismatch/);name='Idea';
  assert.equal((await service.call('rename_session_object',confirmed)).observed.verified,false);
  await assert.rejects(service.call('rename_session_object',confirmed));assert.equal(writes,1);
});

test('Session rename refuses an older or mismatched native context before confirmation',async()=>{
  const args={targetType:'clip',trackId:'track-0',targetId:'track-0:clip-0',name:'Verse',expectedStateVersion:4};
  for(const before of [{stateVersion:4,trackId:'track-0',clipId:args.targetId},{stateVersion:4,trackId:'track-0',clipId:'track-0:clip-1',identityToken:'other'}]){
    const service=new ToolService({bridge:{request:async method=>{assert.equal(method,'get_session_clip_name_context');return before;}}});
    await assert.rejects(service.call('rename_session_object',args),/updated native|identity/);
  }
});
