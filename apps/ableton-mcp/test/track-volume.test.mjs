import { plannedResult } from "./fixtures/tool-results.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {validateToolArguments} from "../src/tool-validation.mjs";
import {getPrompt} from "../src/prompts.mjs";
import {createRouter} from "../src/server.mjs";

test("dB level changes bind native context and use single-use confirmation",async()=>{
  let value=0.75,writes=0;
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_track_volume_edit_context")return {stateVersion:3,trackId:"track-0",identityToken:"native",volume:{value},target:{value:0.53,decibels:-12,displayValue:"-12.0 dB"}};
    assert.equal(method,"set_track_volume_db");writes++;return {stateVersion:4,trackId:params.trackId,verified:true,volume:{value:0.53,decibels:-12}};
  }}});
  const args={trackId:"track-0",volumeDb:-12,expectedStateVersion:3};
  const plan=await service.call("set_track_volume_db",args);assert.equal(writes,0);
  const confirmed={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  value=0.7;await assert.rejects(service.call("set_track_volume_db",confirmed),/hash mismatch/);assert.equal(writes,0);
  value=0.75;const result=await service.call("set_track_volume_db",confirmed);assert.equal(result.observed.verified,true);
  await assert.rejects(service.call("set_track_volume_db",confirmed));assert.equal(writes,1);
});

test("dB level contract and workflow reject unsupported inputs and preserve scope",()=>{
  assert.equal(validateToolArguments("set_track_volume_db",{trackId:"track-0",volumeDb:-12,expectedStateVersion:3}).volumeDb,-12);
  assert.throws(()=>validateToolArguments("set_track_volume_db",{trackId:"track-0",volumeDb:"-12",expectedStateVersion:3}));
  const text=getPrompt("balance-mix",{request:"Lower the bass a little",mode:"autonomous"}).messages[0].content.text;
  for(const phrase of ["set_track_volume_db","automation","manual edits","routing","not prove","listen-to-live-output"])assert.ok(text.includes(phrase),phrase);
  assert.throws(()=>getPrompt("balance-mix",{request:"Balance",mode:"invalid"}));
});

test("dB level tool is callable in all and excluded from core",async()=>{
  const calls=[],service={call:async(name,args)=>{calls.push({name,args});return plannedResult();}};
  const all=createRouter(service),core=createRouter(service,{toolProfile:"core"});
  assert.ok((await all({id:1,method:"tools/list"})).result.tools.some(t=>t.name==="set_track_volume_db"));
  assert.ok(!(await core({id:2,method:"tools/list"})).result.tools.some(t=>t.name==="set_track_volume_db"));
  const args={trackId:"track-0",volumeDb:-12,expectedStateVersion:3};
  assert.equal((await all({id:3,method:"tools/call",params:{name:"set_track_volume_db",arguments:args}})).result.structuredContent.dryRun,true);
  assert.equal((await core({id:4,method:"tools/call",params:{name:"set_track_volume_db",arguments:args}})).error.code,-32601);
  assert.equal(calls.length,1);
});

test('Return and Main dB plans require exact owners and warn about their scope',async()=>{
 for(const trackId of ['return-0','master']){
  let token='original',writes=0;
  const service=new ToolService({bridge:{request:async(method,args)=>{
   if(method==='get_track_volume_edit_context')return {stateVersion:3,trackId:args.trackId,identityToken:token,target:{value:.5}};
   writes++;return {verified:true};
  }}});
  const args={trackId,volumeDb:-12,expectedStateVersion:3};
  assert.equal(validateToolArguments('set_track_volume_db',args).trackId,trackId);
  const plan=await service.call('set_track_volume_db',args);
  assert.match(plan.warning,trackId==='master'?/Main.*entire mix/:/Return.*routed/);
  token='replacement';
  await assert.rejects(()=>service.call('set_track_volume_db',{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}),/hash mismatch/);
  assert.equal(writes,0);
  const fresh=await service.call('set_track_volume_db',args);
  assert.equal((await service.call('set_track_volume_db',{...args,dryRun:false,confirmationToken:fresh.confirmation.token,planHash:fresh.confirmation.planHash})).observed.verified,true);
  assert.equal(writes,1);
 }
});

test('dB plans reject another owner in native readback',async()=>{
 const service=new ToolService({bridge:{request:async()=>({stateVersion:3,trackId:'return-1',identityToken:'native',target:{value:.5}})}});
 await assert.rejects(()=>service.call('set_track_volume_db',{trackId:'return-0',volumeDb:-12,expectedStateVersion:3}),/trackId mismatch/);
});

test('bus balance workflow selects native bus dB readback without widening a track brief',()=>{
 const text=getPrompt('balance-mix',{request:'Lower the reverb Return by 2 dB'}).messages[0].content.text;
 for(const phrase of ['return-N','master','get_set_mixer','entire mix','explicit scope'])assert.ok(text.includes(phrase),phrase);
});
