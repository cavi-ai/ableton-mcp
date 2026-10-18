import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';
import {getPrompt} from '../src/prompts.mjs';
import {toolContracts} from '../src/tool-contracts.mjs';

const args={trackId:'track-0',clipId:'track-0:arrangement-clip-0',startBeats:10,expectedStateVersion:4};
test('Arrangement move binds native source, complete content and staging interval once',async()=>{
 let identity='original',velocity=90,writes=0;
 const before=()=>({stateVersion:4,trackId:args.trackId,clipId:args.clipId,identityToken:identity,source:{notes:[{noteId:3,pitch:60,velocity}]},startBeats:10,endBeats:14,stagingStartBeats:37,stagingEndBeats:41,clips:[]});
 const receipt={moveRequested:true,sourceRetained:false,moveVerified:false,stagingClip:{id:'track-0:arrangement-clip-1'},error:'destination copy failed'};
 const service=new ToolService({bridge:{request:async(method,params)=>{
  if(method==='get_arrangement_move_source')return before();
  assert.equal(method,'move_arrangement_clip');assert.deepEqual(params.before,before());writes++;return receipt;
 }}});
 validateToolArguments('move_arrangement_clip',args);
 const plan=await service.call('move_arrangement_clip',args);assert.equal(writes,0);assert.equal(plan.plan.before.stagingStartBeats,37);
 const confirmed={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 identity='replacement';await assert.rejects(service.call('move_arrangement_clip',confirmed),/changed|mismatch/);identity='original';
 velocity=42;await assert.rejects(service.call('move_arrangement_clip',confirmed),/changed|mismatch/);velocity=90;
 assert.deepEqual((await service.call('move_arrangement_clip',confirmed)).observed,receipt);
 await assert.rejects(service.call('move_arrangement_clip',confirmed));assert.equal(writes,1);
});

test('Arrangement move rejects invalid input and an outdated bridge context',async()=>{
 let calls=0;
 const service=new ToolService({bridge:{request:async()=>{calls++;return {stateVersion:4,trackId:args.trackId,clipId:args.clipId,startBeats:10};}}});
 for(const invalid of [{startBeats:-1},{startBeats:Infinity},{startBeats:NaN},{expectedStateVersion:undefined}])await assert.rejects(service.call('move_arrangement_clip',{...args,...invalid}));
 assert.equal(calls,0);await assert.rejects(service.call('move_arrangement_clip',args),/updated native/);
});

test('move workflow resolves the musical destination and handles retained staging',()=>{
 for(const mode of ['collaborative','autonomous']){
  const text=getPrompt('move-arrangement-part',{request:'Bring the bass phrase into the intro',mode}).messages[0].content.text;
  assert.match(text,/get_selection_context/);assert.match(text,/list_arrangement_cue_points/);assert.match(text,/quarter-note/);
  assert.match(text,/move_arrangement_clip/);assert.match(text,/stagingStartBeats/);assert.match(text,/moveVerified/);
  assert.match(text,/stagingClip/);assert.match(text,/Do not replay/);assert.match(text,/audition_arrangement_passage/);
  for (const reference of new Set(text.match(/[a-z]+(?:_[a-z]+)+/g))) assert.ok(toolContracts[reference], `unknown workflow tool ${reference}`);
 }
 assert.throws(()=>getPrompt('move-arrangement-part',{request:'Move bass',mode:'replace'}),/mode/);
});
