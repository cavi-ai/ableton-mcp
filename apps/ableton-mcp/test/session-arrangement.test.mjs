import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {getPrompt} from "../src/prompts.mjs";

test("Arrangement placement binds source content and native identity before confirmation",async()=>{
  const before={stateVersion:4,trackId:"track-0",clipId:"track-0:clip-0",source:{id:"track-0:clip-0",hasClip:true,lengthBeats:4},beforeArrangement:[],
    sourceGuard:{identityToken:"source-a",contentSha256:"notes-a"}},writes=[];
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_session_clip_arrangement_source")return structuredClone(before);
    if(method==="list_clips")return {stateVersion:4,trackId:"track-0",clips:[before.source]};
    if(method==="list_arrangement_clips")return {stateVersion:4,trackId:"track-0",clips:before.beforeArrangement};
    if(method==="place_session_clip_in_arrangement"){writes.push(params);return {stateVersion:5};}
    throw Error(method);
  }}});
  const args={trackId:"track-0",clipId:"track-0:clip-0",startBeats:8,expectedStateVersion:4};
  for(const field of ["contentSha256","identityToken"]){
    const plan=await service.call("place_session_clip_in_arrangement",args);
    assert.deepEqual(plan.plan.sourceGuard,before.sourceGuard);
    before.sourceGuard[field]+="-changed";
    await assert.rejects(service.call("place_session_clip_in_arrangement",{...args,dryRun:false,
      confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));
    assert.equal(writes.length,0);
  }
});

test("Session arrangement workflow validates mode and is shared by MCP retrieval and prompt",async()=>{
  const service=new ToolService({bridge:{request:async()=>{throw Error("retrieval must not call Live");}}});
  for(const mode of [undefined,"collaborative","autonomous"]){
    const args={request:"Arrange the named chords and bass into two sections; preserve Session clips.",...(mode?{mode}:{})};
    const result=await service.call("get_producer_workflow",{workflow:"arrange-session-ideas",arguments:args});
    assert.deepEqual(result.messages,getPrompt("arrange-session-ideas",args).messages);
  }
  await assert.rejects(service.call("get_producer_workflow",{workflow:"arrange-session-ideas",arguments:{request:"Arrange",mode:"overwrite"}}));
});
