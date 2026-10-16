import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {getPrompt} from "../src/prompts.mjs";

test("public clip duplication binds native source edits and carries a copy name",async()=>{
  let pitch=0,writes=0;
  const service=new ToolService({bridge:{async request(method,params){
    if(method==="get_clip_duplication_source")return {stateVersion:3,trackId:params.trackId,
      sourceClipId:params.sourceClipId,targetClipId:params.targetClipId,identityToken:"pair",
      source:{name:"Vocal",audio:{pitch}},target:{hasClip:false}};
    if(method==="list_clips")return {stateVersion:3,trackId:params.trackId,clips:[]};
    assert.equal(method,"duplicate_clip");assert.equal(params.name,"Warm alternative");assert.equal(params.before.source.audio.pitch,0);
    writes++;return {stateVersion:4,copyVerified:true};
  }}}),router=createRouter(service);
  const args={trackId:"track-0",clipId:"track-0:clip-0",destinationClipId:"track-0:clip-1",name:"Warm alternative",expectedStateVersion:3};
  const request=async args=>{const response=await router({id:1,method:"tools/call",params:{name:"duplicate_clip",arguments:args}});assert.ok(!response.error,JSON.stringify(response));return response.result;};
  const planned=await request(args);assert.equal(planned.isError,undefined,JSON.stringify(planned));
  const dry=planned.structuredContent;assert.equal(dry.plan.before.identityToken,"pair");
  const confirmed={...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};
  pitch=1;assert.equal((await request(confirmed)).isError,true);assert.equal(writes,0);
  pitch=0;assert.equal((await request(confirmed)).structuredContent.observed.copyVerified,true);assert.equal(writes,1);
});

test("audio development workflow resolves selected material and preserves original and manual edits",()=>{
  const text=getPrompt("develop-selected-audio-clip",{request:"Make this loop warmer"}).messages[0].content.text;
  for(const phrase of ["detailClip","duplicate_clip","destinationClipId","seconds","manual edits","warp","source file","partial","heard"])assert.ok(text.includes(phrase),phrase);
});
