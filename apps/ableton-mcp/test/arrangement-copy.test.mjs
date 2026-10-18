import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';
import {createRouter} from '../src/server.mjs';

const args={trackId:'track-0',clipId:'track-0:arrangement-clip-1',destinationTrackId:'track-1',startBeats:16,name:'Piano layer',expectedStateVersion:4};
function fixture(){
 let identity='pair-a',sourceName='Chords',writes=0;
 const before=()=>({stateVersion:4,setFingerprint:'set-a',trackId:args.trackId,clipId:args.clipId,destinationTrackId:args.destinationTrackId,identityToken:identity,source:{name:sourceName,notes:[{noteId:1,pitch:60}]},destinationClips:[],startBeats:16,endBeats:20});
 const receipt={stateVersion:5,copyRequested:true,nativeReturned:true,copyVerified:false,sourcePreserved:true,error:'copy readback mismatch',copiedClipId:'track-1:arrangement-clip-0'};
 const service=new ToolService({bridge:{request:async(method,params)=>{
  if(method==='get_arrangement_copy_source')return before();
  assert.equal(method,'copy_arrangement_clip_to_track');assert.deepEqual(params.before,before());writes++;return receipt;
 }}});
 return {service,identity:v=>identity=v,sourceName:v=>sourceName=v,writes:()=>writes,receipt};
}
test('Arrangement cross-track copy binds exact source, destination and name once',async()=>{
 const f=fixture();validateToolArguments('copy_arrangement_clip_to_track',args);
 const plan=await f.service.call('copy_arrangement_clip_to_track',args);assert.equal(f.writes(),0);assert.equal(plan.plan.name,args.name);assert.equal(plan.plan.before.destinationTrackId,args.destinationTrackId);
 const input={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 f.identity('replacement');await assert.rejects(f.service.call('copy_arrangement_clip_to_track',input),/changed|hash mismatch/);f.identity('pair-a');
 f.sourceName('Manual edit');await assert.rejects(f.service.call('copy_arrangement_clip_to_track',input),/changed|hash mismatch/);f.sourceName('Chords');
 assert.deepEqual((await f.service.call('copy_arrangement_clip_to_track',input)).observed,f.receipt);
 await assert.rejects(f.service.call('copy_arrangement_clip_to_track',input));assert.equal(f.writes(),1);
});
test('Arrangement copy requires valid explicit name and finite destination',async()=>{
 for(const alter of [{name:''},{name:'bad\nname'},{name:'x'.repeat(129)},{startBeats:Infinity},{startBeats:-1},{expectedStateVersion:undefined}]){
  const f=fixture();await assert.rejects(f.service.call('copy_arrangement_clip_to_track',{...args,...alter}));assert.equal(f.writes(),0);
 }
});
test('Arrangement copying stays outside core discovery',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 assert.ok((await all({id:1,method:'tools/list'})).result.tools.some(t=>t.name==='copy_arrangement_clip_to_track'));
 assert.equal((await core({id:2,method:'tools/call',params:{name:'copy_arrangement_clip_to_track',arguments:args}})).error.code,-32601);
});
