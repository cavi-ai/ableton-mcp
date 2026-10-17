import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';
import {getPrompt} from '../src/prompts.mjs';

const base={trackId:'track-0',clipId:'track-0:clip-0',expectedStateVersion:4};
function fixture(){
 let token='clip-a',writes=0;
 const timing={stateVersion:4,trackId:base.trackId,clipId:base.clipId,location:'session',
  launchMode:{supported:true,value:0,name:'trigger',choices:['trigger','gate','toggle','repeat'].map((name,value)=>({name,value}))}};
 const service=new ToolService({bridge:{request:async(method,params)=>{
  if(method==='get_clip_timing')return structuredClone(timing);
  if(method==='get_clip_launch_edit_context')return {stateVersion:4,trackId:base.trackId,clipId:base.clipId,identityToken:token,launchMode:timing.launchMode.value};
  if(method==='set_clip_timing'){writes++;return {...timing,stateVersion:5,launchMode:{...timing.launchMode,value:params.changes.launchMode}};}
  throw Error(method);
 }}});
 return {service,timing,replace(){token='clip-b';},get writes(){return writes;}};
}

test('launch-mode plans resolve an observed choice and bind native clip identity',async()=>{
 const f=fixture(),args={...base,launchMode:'toggle'};
 validateToolArguments('set_clip_timing',args);
 const plan=await f.service.call('set_clip_timing',args);
 assert.equal(plan.plan.changes.launchMode,2);assert.equal(plan.plan.launchEditContext.identityToken,'clip-a');assert.equal(f.writes,0);
 const result=await f.service.call('set_clip_timing',{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
 assert.equal(f.writes,1);assert.equal(result.observed.launchMode.value,2);
});

test('same-value native replacement invalidates a launch-mode confirmation',async()=>{
 const f=fixture(),args={...base,launchMode:1},p=await f.service.call('set_clip_timing',args);f.replace();
 await assert.rejects(()=>f.service.call('set_clip_timing',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}),/hash|changed/);
 assert.equal(f.writes,0);
});

test('launch-mode planning refuses Arrangement clips, unavailable modes and invalid choices',async()=>{
 for(const value of [true,'unknown',4,-1])await assert.rejects(()=>fixture().service.call('set_clip_timing',{...base,launchMode:value}));
 const f=fixture();f.timing.location='arrangement';await assert.rejects(()=>f.service.call('set_clip_timing',{...base,launchMode:'gate'}),/unavailable|Session/);
 f.timing.location='session';f.timing.launchMode={supported:false};await assert.rejects(()=>f.service.call('set_clip_timing',{...base,launchMode:'gate'}),/unavailable|supported/);
});

test('Session workflow separates mode configuration from held launch input',()=>{
 const text=getPrompt('build-session-scene',{request:'Prepare the chosen clips for live triggering.'}).messages[0].content.text;
 assert.match(text,/launchMode/);assert.match(text,/held.button/);assert.match(text,/Gate.*Repeat/s);
});
