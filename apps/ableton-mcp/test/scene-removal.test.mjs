import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';
function fixture(){let token='native',writes=0;const service=new ToolService({bridge:{request:async(method,args)=>{
 if(method==='list_scenes')return {stateVersion:4,scenes:[{id:'scene-0',name:'Verse'},{id:'scene-1',name:'Chorus'}]};
 if(method==='get_scene_removal_context')return {stateVersion:4,sceneId:'scene-0',identityToken:token,scenes:[{name:'Verse'},{name:'Chorus'}],tracks:[{slots:[{content:{notes:[{noteId:7,velocity:90}]}},{}]}],occupiedClips:[{trackId:'track-0',clipId:'track-0:clip-0',name:'Phrase'}]};
 assert.equal(method,'delete_session_object');assert.equal(args.allowContent,true);assert.equal(args.sceneRemovalContext.identityToken,token);writes++;return {deleteRequested:true,nativeReturned:false,targetAbsent:true,deletionVerified:false,error:'native reply lost'};
 }}});return {service,setToken:value=>token=value,writes:()=>writes};}
test('scene removal binds native context and content authority, preserving partial outcomes',async()=>{
 const f=fixture(),args={targetType:'scene',targetId:'scene-0',allowContent:true,expectedStateVersion:4},plan=await f.service.call('delete_session_object',args);
 assert.equal(f.writes(),0);assert.equal(plan.plan.sceneRemovalContext.identityToken,'native');assert.equal(plan.plan.allowContent,true);
 const input={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};f.setToken('replacement');await assert.rejects(f.service.call('delete_session_object',input));f.setToken('native');const result=await f.service.call('delete_session_object',input);assert.equal(result.observed.deletionVerified,false);assert.equal(result.observed.targetAbsent,true);assert.equal(f.writes(),1);await assert.rejects(f.service.call('delete_session_object',input));
});
test('populated scene refusal occurs before a writer or confirmation token',async()=>{
 const f=fixture();await assert.rejects(f.service.call('delete_session_object',{targetType:'scene',targetId:'scene-0',expectedStateVersion:4}),/allowContent/);assert.equal(f.writes(),0);
});
test('scene removal workflow requires row-specific intent and retains unrelated material',()=>{
 const text=getPrompt('remove-session-scene',{request:'Remove only the rejected chorus row'}).messages[0].content.text;
 for(const word of ['delete_session_object','allowContent','get_scene_launch_context','deletionVerified','targetAbsent','original','manual','playing','partial'])assert.ok(text.includes(word),word);
 assert.match(text,/never.*replay/i);assert.match(text,/IDs.*shift/i);assert.match(text,/does not.*back.?up/i);
});
