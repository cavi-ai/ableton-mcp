import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {getProducerWorkflow} from "../src/prompts.mjs";

function fixture(){
  const source={stateVersion:3,trackId:"track-0",deviceId:"track-0:device-0",identityToken:"native",before:{controls:{Repeat:{value:0}}}};
  const handle={stateVersion:4,fillId:"owned",status:"active",repeatOffObserved:false};
  const calls=[];
  const service=new ToolService({bridge:{request:async(method,args)=>{
    calls.push({method,args});
    if(method==="get_beat_repeat_fill_source")return structuredClone(source);
    if(method==="perform_beat_repeat_fill")return structuredClone(handle);
    if(method==="get_beat_repeat_fill")return args.fillId?structuredClone(handle):{stateVersion:4,fills:[structuredClone(handle)]};
    if(method==="finish_beat_repeat_fill")return {...handle,stateVersion:5,status:"cancelled",repeatOffObserved:true,handleReleased:true};
    throw Error(method);
  }}});
  return {service,source,handle,calls,args:{trackId:"track-0",deviceId:"track-0:device-0",expectedStateVersion:3,durationSeconds:1}};
}

test("temporary Repeat start is previewed and executes one unchanged confirmed native plan",async()=>{
  const f=fixture(),plan=await f.service.call("perform_beat_repeat_fill",f.args);
  assert.equal(plan.dryRun,true);assert.equal(f.calls.length,1);assert.match(plan.warning,/display ticks|wall-clock/);
  const result=await f.service.call("perform_beat_repeat_fill",{...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  assert.equal(result.observed.fillId,"owned");assert.equal(f.calls.filter(c=>c.method==="perform_beat_repeat_fill").length,1);
  await assert.rejects(f.service.call("perform_beat_repeat_fill",{...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}),/confirmation/);
});

test("fill confirmation rejects changed native source and invalid duration before writing",async()=>{
  const f=fixture(),plan=await f.service.call("perform_beat_repeat_fill",f.args);
  f.source.identityToken="replacement";
  await assert.rejects(f.service.call("perform_beat_repeat_fill",{...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}),/hash|changed/);
  for(const durationSeconds of [.1,9,NaN,true])await assert.rejects(f.service.call("perform_beat_repeat_fill",{...f.args,durationSeconds}),/duration/);
  assert.equal(f.calls.filter(c=>c.method==="perform_beat_repeat_fill").length,0);
});

test("reconnect can list retained fills and early cancellation uses a fresh handle confirmation",async()=>{
  const f=fixture();assert.equal((await f.service.call("get_beat_repeat_fill",{})).fills[0].fillId,"owned");
  const args={fillId:"owned",expectedStateVersion:4,cancel:true};
  const plan=await f.service.call("finish_beat_repeat_fill",args);
  const result=await f.service.call("finish_beat_repeat_fill",{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  assert.equal(result.observed.status,"cancelled");assert.equal(result.observed.handleReleased,true);
  f.handle.status="complete";
  await assert.rejects(f.service.call("finish_beat_repeat_fill",{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}),/hash|changed/);
});

test("fill MCP schemas and annotations preserve the core tool catalog",async()=>{
  const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:"core"});
  const listed=(await all({id:1,method:"tools/list"})).result.tools;
  for(const name of ["perform_beat_repeat_fill","get_beat_repeat_fill","finish_beat_repeat_fill"])assert.ok(listed.find(t=>t.name===name));
  assert.equal(listed.find(t=>t.name==="get_beat_repeat_fill").annotations.readOnlyHint,true);
  assert.ok(!(await core({id:2,method:"tools/list"})).result.tools.some(t=>t.name==="perform_beat_repeat_fill"));
  const count=f.calls.length;
  const invalid=await all({id:3,method:"tools/call",params:{name:"perform_beat_repeat_fill",arguments:{...f.args,durationSeconds:9}}});
  assert.equal(invalid.error.code,-32602);assert.equal(f.calls.length,count);
});

test("performance workflow is discoverable offline and distinguishes Repeat release from bypass",()=>{
  assert.ok(getProducerWorkflow().workflows.some(w=>w.name==="perform-repeat-fill"));
  assert.throws(()=>getProducerWorkflow({workflow:"perform-repeat-fill"}),/request/);
  const text=getProducerWorkflow({workflow:"perform-repeat-fill",arguments:{request:"Try a short triplet fill"}}).messages[0].content.text;
  for(const term of ["perform_beat_repeat_fill","get_beat_repeat_fill","finish_beat_repeat_fill","manual edits","Chance"])assert.ok(text.includes(term),term);
  assert.match(text,/not.*bypass|bypass.*not/i);assert.match(text,/not.*beat|beat.*not/i);
});
