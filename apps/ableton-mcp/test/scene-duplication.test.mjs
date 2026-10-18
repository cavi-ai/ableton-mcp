import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';

test('whole scene copy binds native material and confirms once with partial receipt',async()=>{
 let token='native-scene',writes=0;
 const service=new ToolService({bridge:{request:async(method,args)=>{
  if(method==='list_scenes')return {stateVersion:4,scenes:[{id:'scene-0',name:'Verse'},{id:'scene-1',name:'Chorus'}]};
  if(method==='get_scene_duplication_context')return {stateVersion:4,sceneId:'scene-0',destinationId:'scene-1',identityToken:token,scenes:[{name:'Verse'},{name:'Chorus'}],tracks:[{slots:[{content:{notes:[{noteId:7,velocity:90}]}},{}]}]};
  assert.equal(method,'duplicate_session_object');assert.equal(args.sceneCopyContext.identityToken,token);writes++;return {copyRequested:true,copyVerified:false,error:'retained row'};
 }}});
 const args={targetType:'scene',targetId:'scene-0',expectedStateVersion:4},plan=await service.call('duplicate_session_object',args);
 assert.equal(writes,0);assert.equal(plan.plan.sceneCopyContext.identityToken,token);
 const confirmed={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 token='replaced';await assert.rejects(service.call('duplicate_session_object',confirmed));token='native-scene';
 const result=await service.call('duplicate_session_object',confirmed);assert.equal(result.observed.copyVerified,false);assert.equal(writes,1);await assert.rejects(service.call('duplicate_session_object',confirmed));
});

test('scene alternative workflow separates duplication from full row audition',()=>{
 const text=getPrompt('develop-session-scene',{request:'Try a sparse version of the verse'}).messages[0].content.text;
 for(const word of ['duplicate_session_object','get_scene_launch_context','copyVerified','empty','recording','partial','original','manual','get_selection_context'])assert.ok(text.includes(word),word);
 assert.match(text,/does not launch/);assert.match(text,/scene IDs.*shift/i);
});
