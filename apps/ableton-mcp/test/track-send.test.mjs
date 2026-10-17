import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {validateToolArguments} from "../src/tool-validation.mjs";
import {getPrompt} from "../src/prompts.mjs";
import {createRouter} from "../src/server.mjs";

const args={trackId:"track-0",sendId:"send-0",returnTrackId:"return-0",sendDb:-12,expectedStateVersion:3};

test("send dB plans bind native identity, current gain and the selected Return with single-use confirmation",async()=>{
  let value=.36,identity="native-send",writes=0;
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_track_send_edit_context")return {stateVersion:3,trackId:args.trackId,sendId:args.sendId,returnTrackId:args.returnTrackId,
      identityToken:identity,send:{value},target:{value:.64,decibels:-12}};
    assert.equal(method,"set_track_send_db");writes++;assert.equal(params.returnTrackId,"return-0");
    return {stateVersion:4,verified:true,send:{decibels:-12}};
  }}});
  const plan=await service.call("set_track_send_db",args);assert.equal(writes,0);
  const confirmed={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  value=.5;await assert.rejects(service.call("set_track_send_db",confirmed),/hash mismatch/);
  value=.36;identity="replacement-return";await assert.rejects(service.call("set_track_send_db",confirmed),/hash mismatch/);assert.equal(writes,0);
  identity="native-send";assert.equal((await service.call("set_track_send_db",confirmed)).observed.verified,true);
  await assert.rejects(service.call("set_track_send_db",confirmed));assert.equal(writes,1);
});

test("send dB contract and mix workflow preserve named destinations and unsupported-state boundaries",async()=>{
  assert.equal(validateToolArguments("set_track_send_db",args).sendDb,-12);
  assert.equal(validateToolArguments("set_track_send_db",{...args,sendDb:"-inf"}).sendDb,"-inf");
  assert.throws(()=>validateToolArguments("set_track_send_db",{...args,sendDb:"-12"}));
  const service=new ToolService({bridge:{request:async()=>{throw Error("must reject before bridge");}}});
  for(const input of [{...args,sendId:"send-00"},{...args,returnTrackId:"return-1"},{...args,sendDb:Infinity}]){
    await assert.rejects(service.call("set_track_send_db",input),/canonical|same|finite/);
  }
  const text=getPrompt("balance-mix",{request:"Raise the piano's Reverb send by 2 dB"}).messages[0].content.text;
  for(const phrase of ["set_track_send_db","returnTrackId","silent send","automation","pre/post","manual edits"])assert.ok(text.includes(phrase),phrase);
});

test("send dB tool is callable only in the all profile",async()=>{
  const calls=[],service={call:async(name,input)=>{calls.push({name,input});return {dryRun:true};}};
  const all=createRouter(service),core=createRouter(service,{toolProfile:"core"});
  assert.ok((await all({id:1,method:"tools/list"})).result.tools.some(t=>t.name==="set_track_send_db"));
  assert.ok(!(await core({id:2,method:"tools/list"})).result.tools.some(t=>t.name==="set_track_send_db"));
  assert.equal((await all({id:3,method:"tools/call",params:{name:"set_track_send_db",arguments:args}})).result.structuredContent.dryRun,true);
  assert.equal((await core({id:4,method:"tools/call",params:{name:"set_track_send_db",arguments:args}})).error.code,-32601);
  assert.equal(calls.length,1);
});
