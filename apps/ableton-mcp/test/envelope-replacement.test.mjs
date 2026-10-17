import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {validateToolArguments} from "../src/tool-validation.mjs";
import {toolContracts} from "../src/tool-contracts.mjs";

const args={trackId:"track-0",clipId:"track-0:clip-0",deviceId:"track-0:device-0",parameterId:"parameter-1",expectedStateVersion:4,
  points:[{time:0,duration:2,value:-1},{time:2,duration:2,value:.8}]};

test("existing envelope replacement requires explicit authority and binds sampled native context",async()=>{
  let sample=.2,identity="original",writes=0;
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_clip_envelope_replacement_context")return {stateVersion:4,trackId:args.trackId,clipId:args.clipId,deviceId:args.deviceId,parameterId:args.parameterId,
      identityToken:identity,contentDigest:"notes",parametersDigest:"parameters",envelopeExists:true,fullCurveCaptured:false,
      envelopeSamples:[{time:1,value:sample}],points:[{time:0,duration:2,requestedValue:-1,value:0},{time:2,duration:2,requestedValue:.8,value:.8}]};
    assert.equal(method,"set_clip_parameter_envelope");assert.equal(params.replaceExisting,true);writes++;
    return {stateVersion:5,trackId:args.trackId,clipId:args.clipId,deviceId:args.deviceId,parameterId:args.parameterId,replaced:true,replacedExisting:true,verified:true,verificationScope:"sampled_steps"};
  }}});
  await assert.rejects(service.call("set_clip_parameter_envelope",args),/replaceExisting/);assert.equal(writes,0);
  const input={...args,replaceExisting:true},plan=await service.call("set_clip_parameter_envelope",input);assert.equal(plan.plan.before.fullCurveCaptured,false);
  const confirmed={...input,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  sample=.7;await assert.rejects(service.call("set_clip_parameter_envelope",confirmed),/hash mismatch/);sample=.2;
  identity="replacement";await assert.rejects(service.call("set_clip_parameter_envelope",confirmed),/hash mismatch/);identity="original";
  assert.equal((await service.call("set_clip_parameter_envelope",confirmed)).observed.verified,true);
  await assert.rejects(service.call("set_clip_parameter_envelope",confirmed));assert.equal(writes,1);
});

test("replacement authority and pattern capacity are validated at the MCP contract",()=>{
  validateToolArguments("set_clip_parameter_envelope",{...args,replaceExisting:true});
  validateToolArguments("set_clip_parameter_envelope",{...args,points:Array.from({length:512},(_,i)=>({time:i/8,duration:1/8,value:1}))});
  assert.throws(()=>validateToolArguments("set_clip_parameter_envelope",{...args,replaceExisting:"true"}));
  assert.throws(()=>validateToolArguments("set_clip_parameter_envelope",{...args,points:Array(513).fill({time:0,duration:1,value:1})}));
  assert.equal(toolContracts.set_clip_parameter_envelope.annotations.destructiveHint,true);
});
