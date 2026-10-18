import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';

for(const method of ['duplicate_clip','duplicate_session_object']){
  test(`${method} binds strengthened context and retains partial receipts once`,async()=>{
    let identity='original',pitch=0,writes=0,guard=2;
    const args={trackId:'track-0',expectedStateVersion:4,...(method==='duplicate_clip'?{clipId:'track-0:clip-0',destinationClipId:'track-0:clip-1',name:'Alternative'}:{targetType:'clip',targetId:'track-0:clip-0'})};
    const service=new ToolService({bridge:{request:async(name,params)=>{
      if(name==='list_clips')return {stateVersion:4,trackId:'track-0',clips:[{id:'track-0:clip-0',name:'Phrase',hasClip:true},{id:'track-0:clip-1',hasClip:false}]};
      if(name==='get_clip_duplication_source')return {stateVersion:4,copyGuardVersion:guard,trackId:'track-0',sourceClipId:'track-0:clip-0',targetTrackId:'track-0',targetClipId:'track-0:clip-1',identityToken:identity,source:{name:'Phrase',audio:{pitch}},sourceClips:[],targetClips:[]};
      assert.equal(name,method);assert.equal(params.before.copyGuardVersion,2);writes++;
      if(method==='duplicate_session_object'){assert.equal(params.target.destinationId,'track-0:clip-1');assert.equal(params.name,undefined);}
      return {stateVersion:5,trackId:'track-0',sourceTrackId:'track-0',sourceClipId:'track-0:clip-0',copiedClipId:'track-0:clip-1',copyRequested:true,nativeReturned:false,targetOccupied:true,copyVerified:false,error:'failed after creating'};
    }}});
    guard=1;await assert.rejects(service.call(method,args),/updated bridge/);assert.equal(writes,0);guard=2;
    const dry=await service.call(method,args),confirmed={...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};
    identity='replacement';await assert.rejects(service.call(method,confirmed),/hash mismatch/);identity='original';
    pitch=12;await assert.rejects(service.call(method,confirmed),/hash mismatch/);pitch=0;
    const result=await service.call(method,confirmed);assert.equal(result.observed.copyVerified,false);assert.equal(result.observed.targetOccupied,true);
    await assert.rejects(service.call(method,confirmed));assert.equal(writes,1);
  });
}

test('reuse workflow describes explicit partial-copy observations without cleanup',()=>{
  const text=getPrompt('reuse-session-clip',{request:'Try this part on the piano'}).messages[0].content.text;
  for(const term of ['copyRequested','nativeReturned','nameWriteRequested','targetOccupied','sourcePreserved','otherClipsRetained','undo entry','No automatic cleanup'])assert.ok(text.includes(term),term);
});
