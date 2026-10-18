import test from 'node:test';import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';import {getPrompt} from '../src/prompts.mjs';
function fixture(){let token='native',writes=0;const service=new ToolService({bridge:{request:async(method,args)=>{
 if(method==='get_track_removal_context')return {stateVersion:4,trackId:'track-0',identityToken:token,removedTracks:[{trackId:'track-0',name:'Group',sessionClipCount:0,arrangementClipCount:0,deviceCount:1,clips:[],devices:[{id:'track-0:device-0',name:'Group effect'}]},{trackId:'track-1',name:'Child',sessionClipCount:0,arrangementClipCount:1,deviceCount:0,clips:[{clipId:'track-1:arrangement-clip-0',name:'Arrangement take',location:'arrangement'}],devices:[]}]};
 assert.equal(method,'delete_session_object');assert.equal(args.allowContent,true);assert.equal(args.trackRemovalContext.identityToken,token);writes++;return {deleteRequested:true,nativeReturned:false,targetsAbsent:true,deletionVerified:false,error:'retained outcome'};
 }}});return {service,setToken:v=>token=v,writes:()=>writes};}
test('track removal signs the whole Group subtree and Arrangement content',async()=>{
 const f=fixture(),args={targetType:'track',targetId:'track-0',allowContent:true,expectedStateVersion:4},plan=await f.service.call('delete_session_object',args);assert.equal(f.writes(),0);assert.equal(plan.plan.trackRemovalContext.removedTracks.length,2);assert.equal(plan.plan.target.clipCount,1);assert.equal(plan.plan.target.deviceCount,1);
 const input={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};f.setToken('replaced');await assert.rejects(f.service.call('delete_session_object',input));f.setToken('native');const result=await f.service.call('delete_session_object',input);assert.equal(result.observed.targetsAbsent,true);assert.equal(result.observed.deletionVerified,false);assert.equal(f.writes(),1);await assert.rejects(f.service.call('delete_session_object',input));
});
test('track content authority is mandatory before issuing a deletion plan',async()=>{
 const f=fixture();await assert.rejects(f.service.call('delete_session_object',{targetType:'track',targetId:'track-0',expectedStateVersion:4}),/allowContent/);assert.equal(f.writes(),0);
});
test('track removal workflow distinguishes deletion, ungrouping, dependencies and backups',()=>{
 const text=getPrompt('remove-track',{request:'Remove the unwanted Group and its children'}).messages[0].content.text;
 for(const word of ['Arrangement','allowContent','delete_session_object','ungroup_tracks','targetsAbsent','deletionVerified','sidechain','original','partial','automation'])assert.ok(text.includes(word),word);
 assert.match(text,/never.*replay/i);assert.match(text,/IDs.*shift/i);assert.match(text,/stopped/);
});
