import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';
import {toolContracts} from '../src/tool-contracts.mjs';

for (const method of ['delete_clip','delete_arrangement_clip','delete_session_object']) {
  test(`${method} binds native identity, exposed content and whole-clip scope once`, async()=>{
    const location=method==='delete_arrangement_clip'?'arrangement':'session',clipId=location==='session'?'track-0:clip-0':'track-0:arrangement-clip-0';
    const args={trackId:'track-0',expectedStateVersion:4,...(method==='delete_session_object'?{targetType:'clip',targetId:clipId}:{clipId})};
    let identity='original',velocity=90,writes=0;
    const before=()=>({stateVersion:4,trackId:args.trackId,clipId,location,identityToken:identity,source:{name:'Phrase',notes:[{noteId:3,pitch:60,velocity}]},scope:{wholeClip:true,includesClipEnvelopesAndNoteExpression:true,restorableSnapshot:false}});
    const receipt={deletionRequested:true,nativeReturned:false,targetCleared:true,deletionVerified:false,error:'failed after deletion'};
    const service=new ToolService({bridge:{request:async(name,params)=>{
      if(name==='get_clip_removal_source'){assert.equal(params.clipId,clipId);assert.equal(params.location,location);return before();}
      assert.equal(name,method);assert.deepEqual(params.before,before());writes++;return receipt;
    }}});
    const dry=await service.call(method,args);assert.equal(writes,0);assert.deepEqual(dry.plan.before.scope,before().scope);
    if(method==='delete_session_object')assert.equal(dry.plan.target.targetId,clipId);
    const confirmed={...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};
    identity='replacement';await assert.rejects(service.call(method,confirmed),/changed|mismatch/);identity='original';
    velocity=42;await assert.rejects(service.call(method,confirmed),/changed|mismatch/);velocity=90;
    assert.deepEqual((await service.call(method,confirmed)).observed,receipt);
    await assert.rejects(service.call(method,confirmed));assert.equal(writes,1);
  });
}

test('clip removal requires fresh state and an updated whole-clip context',async()=>{
  let calls=0;
  const service=new ToolService({bridge:{request:async()=>{calls++;return {stateVersion:4,trackId:'track-0',clipId:'track-0:clip-0',location:'session'};}}});
  const args={trackId:'track-0',clipId:'track-0:clip-0'};
  await assert.rejects(service.call('delete_clip',args),/expectedStateVersion/);assert.equal(calls,0);
  await assert.rejects(service.call('delete_clip',{...args,expectedStateVersion:4}),/updated native/);
});

test('whole-clip removal workflow resolves destructive scope and actual outcomes',()=>{
  for(const mode of ['collaborative','autonomous']){
    const text=getPrompt('remove-whole-clip',{request:'Discard the alternate bass take',mode}).messages[0].content.text;
    for(const reference of new Set(text.match(/[a-z]+(?:_[a-z]+)+/g)))assert.ok(toolContracts[reference],`unknown workflow tool ${reference}`);
    assert.match(text,/get_selection_context/);assert.match(text,/whole clip/);assert.match(text,/clip envelopes and note expression/);
    assert.match(text,/not a restorable backup/);assert.match(text,/delete_arrangement_clip/);assert.match(text,/delete_clip/);
    assert.match(text,/targetCleared/);assert.match(text,/deletionVerified/);assert.match(text,/Do not replay/);
    assert.match(text,/already authorized/);
  }
  assert.throws(()=>getPrompt('remove-whole-clip',{request:'Discard take',mode:'replace'}),/mode/);
});
