import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";

const args={trackIds:["track-0"],startBeats:8,endBeats:16,expectedStateVersion:4};
function fixture(){
  const source={stateVersion:4,documentId:"document",loop:{enabled:false,startBeats:0,lengthBeats:4}},writes=[];
  const service=new ToolService({bridge:{request:async(name,input)=>{
    if(name==="get_arrangement_audition_source")return structuredClone(source);
    if(name==="audition_arrangement_passage"){writes.push(input);return {stateVersion:5,started:true};}
    throw Error(name);
  }}});
  return {service,source,writes};
}
test("Arrangement audition plans without playback, binds current controls and executes a single-use plan",async()=>{
  const {service,writes}=fixture(),plan=await service.call("audition_arrangement_passage",args);
  assert.equal(plan.dryRun,true);assert.equal(writes.length,0);
  const result=await service.call("audition_arrangement_passage",{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  assert.equal(result.observed.started,true);assert.equal(writes.length,1);
  assert.deepEqual(writes[0].trackIds,args.trackIds);
  await assert.rejects(service.call("audition_arrangement_passage",{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));
});
test("manual context changes and bridge reload invalidate audition confirmation before a write",async()=>{
  for(const change of ["document","loop","version"]){
    const {service,source,writes}=fixture(),plan=await service.call("audition_arrangement_passage",args);
    if(change==="document")source.documentId="new";
    if(change==="loop")source.loop.startBeats=2;
    if(change==="version")source.stateVersion=5;
    await assert.rejects(service.call("audition_arrangement_passage",{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));
    assert.equal(writes.length,0);
  }
});
test("audition is advertised only in all and rejects invalid range and track scope",async()=>{
  const {service,writes}=fixture(),all=createRouter(service),core=createRouter(service,{toolProfile:"core"});
  const tool=(await all({id:1,method:"tools/list"})).result.tools.find(t=>t.name==="audition_arrangement_passage");
  assert.equal(tool.annotations.readOnlyHint,false);
  assert.equal((await core({id:2,method:"tools/call",params:{name:tool.name,arguments:args}})).error.code,-32601);
  for(const invalid of [{trackIds:[]},{trackIds:["track-0","track-0"]},{trackIds:["master"]},{endBeats:8},{startBeats:-1},{endBeats:1000}])
    await assert.rejects(service.call(tool.name,{...args,...invalid}));
  assert.equal(writes.length,0);
});
