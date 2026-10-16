import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {getPrompt} from "../src/prompts.mjs";

test("fixed-length recording binds native readiness and refuses changed input before dispatch",async()=>{
  let input="external",writes=0;
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_session_recording_source")return {stateVersion:3,trackId:params.trackId,clipId:params.clipId,
      identityToken:"native-slot",armed:true,canBeArmed:true,isFrozen:false,slot:{id:params.clipId,hasClip:false},
      routing:{input},launchQuantizationChoices:[{value:1,name:"none"}]};
    if(method==="list_clips")return {stateVersion:3,trackId:params.trackId,armed:true,canBeArmed:true,isFrozen:false,
      clips:[{id:params.clipId,hasClip:false}],launchQuantizationChoices:[{value:1,name:"none"}]};
    assert.equal(method,"launch_clip");assert.equal(params.beforeRecording.routing.input,"external");
    writes++;return {stateVersion:4,recordingRequested:true,recordingVerified:false};
  }}});
  const args={trackId:"track-0",clipId:"track-0:clip-1",recordLengthBeats:4,launchQuantization:"none",expectedStateVersion:3};
  const planned=await service.call("launch_clip",args);
  assert.equal(planned.plan.beforeRecording?.identityToken,"native-slot");assert.equal(writes,0);
  const confirmed={...args,dryRun:false,confirmationToken:planned.confirmation.token,planHash:planned.confirmation.planHash};
  input="changed";await assert.rejects(service.call("launch_clip",confirmed),/hash mismatch/);assert.equal(writes,0);
  input="external";assert.equal((await service.call("launch_clip",confirmed)).observed.recordingVerified,false);assert.equal(writes,1);
});

test("Session take workflow separates recording authority, completion and recovery",()=>{
  const text=getPrompt("record-session-take",{request:"Record four bars on the selected input"}).messages[0].content.text;
  for(const phrase of ["highlightedClipSlot","recordLengthBeats","isRecording","manual edits","input","never blindly","not prove","length mismatch"])assert.ok(text.includes(phrase),phrase);
});
