import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'arrangement-audio-'));t.after(()=>rm(dir,{recursive:true,force:true}));const sourcePath=join(dir,'take.wav');await writeFile(sourcePath,'source');
 let identity='track-a',writes=0;const receipt={stateVersion:5,nativeReturned:true,importVerified:false,createdClipId:'track-0:arrangement-clip-0',error:'finalization failed'};
 const service=new ToolService({bridge:{request:async(method,params)=>{
  if(method==='get_arrangement_audio_import_target')return {stateVersion:4,trackId:'track-0',trackName:'Vocal',identityToken:identity,startBeats:16,clips:[]};
  assert.equal(method,'create_arrangement_audio_clip');assert.equal(params.sourceFile.size,'6');writes++;return receipt;
 }}});
 return {service,args:{trackId:'track-0',startBeats:16,sourcePath,name:'Vocal — imported',expectedStateVersion:4},identity:v=>identity=v,writes:()=>writes,receipt};
}
test('audio Arrangement import binds file revision and native owner in a single-use plan',async t=>{
 const f=await fixture(t),plan=await f.service.call('create_arrangement_audio_clip',f.args);assert.equal(f.writes(),0);assert.equal(plan.plan.sourceFile.size,'6');assert.equal(plan.plan.name,f.args.name);
 const input={...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};f.identity('replacement');await assert.rejects(f.service.call('create_arrangement_audio_clip',input));f.identity('track-a');
 assert.deepEqual((await f.service.call('create_arrangement_audio_clip',input)).observed,f.receipt);await assert.rejects(f.service.call('create_arrangement_audio_clip',input));assert.equal(f.writes(),1);
});
test('a changed file invalidates import before native mutation',async t=>{
 const f=await fixture(t),plan=await f.service.call('create_arrangement_audio_clip',f.args);await writeFile(f.args.sourcePath,'changed source');
 await assert.rejects(f.service.call('create_arrangement_audio_clip',{...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));assert.equal(f.writes(),0);
});
test('audio Arrangement import requires explicit valid arguments and stays outside core',async t=>{
 const f=await fixture(t),route=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 for(const change of [{name:''},{name:'bad\nname'},{startBeats:-1},{sourcePath:undefined}])assert.equal((await route({id:1,method:'tools/call',params:{name:'create_arrangement_audio_clip',arguments:{...f.args,...change}}})).error.code,-32602);
 assert.equal((await core({id:2,method:'tools/call',params:{name:'create_arrangement_audio_clip',arguments:f.args}})).error.code,-32601);assert.equal(f.writes(),0);
});
test('audio import workflow distinguishes direct empty-track import from staged warped placement',()=>{
 const text=getPrompt('import-audio-file',{request:'Bring this vocal into the verse',mode:'autonomous'}).messages[0].content.text;
 assert.match(text,/create_arrangement_audio_clip/);assert.match(text,/place_session_clip_in_arrangement/);assert.match(text,/unwarped/);
 assert.throws(()=>getPrompt('import-audio-file',{request:'Vocal',mode:'unknown'}));
});
