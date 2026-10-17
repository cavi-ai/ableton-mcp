import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {validateToolArguments} from "../src/tool-validation.mjs";

const args={trackId:"track-0",clipId:"track-0:clip-0",deviceId:"track-0:device-0",parameterId:"parameter-1",expectedStateVersion:4,
  points:[{time:0,duration:2,targetDisplay:"200 Hz"},{time:2,duration:2,targetDisplay:"2 kHz"}]};

test("create-only envelope plans bind native clip content, parameter context and exact steps",async()=>{
  let identity="clip-a",digest="notes-a",exists=false,writes=0;
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_clip_envelope_creation_context")return {stateVersion:4,trackId:args.trackId,clipId:args.clipId,deviceId:args.deviceId,parameterId:args.parameterId,
      identityToken:identity,contentDigest:digest,parametersDigest:"parameters-a",envelopeExists:exists,points:[{time:0,duration:2,value:.333},{time:2,duration:2,value:.666}]};
    assert.equal(method,"create_clip_parameter_envelope");writes++;assert.deepEqual(params.points,args.points);
    return {stateVersion:5,trackId:args.trackId,clipId:args.clipId,deviceId:args.deviceId,parameterId:args.parameterId,created:true,verified:true,verificationScope:"sampled_steps"};
  }}});
  const plan=await service.call("create_clip_parameter_envelope",args);assert.equal(writes,0);
  const confirmed={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  identity="replacement";await assert.rejects(service.call("create_clip_parameter_envelope",confirmed),/hash mismatch/);identity="clip-a";
  digest="edited-notes";await assert.rejects(service.call("create_clip_parameter_envelope",confirmed),/hash mismatch/);digest="notes-a";
  exists=true;await assert.rejects(service.call("create_clip_parameter_envelope",confirmed),/existing envelope/);exists=false;
  assert.equal((await service.call("create_clip_parameter_envelope",confirmed)).observed.verified,true);
  await assert.rejects(service.call("create_clip_parameter_envelope",confirmed));assert.equal(writes,1);
});

test("the envelope contract rejects mixed or oversized points and excludes the tool from core",async()=>{
  validateToolArguments("create_clip_parameter_envelope",args);
  validateToolArguments("create_clip_parameter_envelope",{...args,points:[{time:0,duration:4,value:1}]});
  for(const points of [[],Array(129).fill({time:0,duration:1,value:1}),[{time:0,duration:4,value:1,targetDisplay:"2 kHz"}]]){
    assert.throws(()=>validateToolArguments("create_clip_parameter_envelope",{...args,points}));
  }
  const service=new ToolService({bridge:{request:async()=>{throw Error("native refusal");}}}),all=createRouter(service),core=createRouter(service,{toolProfile:"core"});
  assert.ok((await all({id:1,method:"tools/list"})).result.tools.some(t=>t.name==="create_clip_parameter_envelope"));
  assert.equal((await core({id:2,method:"tools/call",params:{name:"create_clip_parameter_envelope",arguments:args}})).error.code,-32601);
  assert.equal((await all({id:3,method:"tools/call",params:{name:"create_clip_parameter_envelope",arguments:args}})).result.isError,true);
});
