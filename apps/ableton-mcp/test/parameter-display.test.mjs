import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {validateToolArguments} from "../src/tool-validation.mjs";

const args={trackId:"track-0",deviceId:"track-0:device-0",parameterId:"parameter-1",targetDisplay:"2 kHz",expectedStateVersion:4};

test("native display edits bind complete context and consume confirmation once",async()=>{
  let value=.4,identity="first",digest="mode-a",writes=0;
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_device_parameter_display_context")return {stateVersion:4,trackId:args.trackId,deviceId:args.deviceId,parameterId:args.parameterId,
      identityToken:identity,parametersDigest:digest,parameter:{value},target:{value:.666,quantity:{value:2000,unit:"Hz"}}};
    assert.equal(method,"set_device_parameter_display");writes++;assert.equal(params.targetDisplay,"2 kHz");
    return {stateVersion:5,trackId:args.trackId,deviceId:args.deviceId,parameterId:args.parameterId,verified:true,parameter:{value:.666,displayValue:"2.00 kHz"}};
  }}});
  const plan=await service.call("set_device_parameter_display",args);assert.equal(writes,0);
  const confirmed={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  for(const change of [()=>value=.5,()=>identity="replacement",()=>digest="mode-b"]){
    change();await assert.rejects(service.call("set_device_parameter_display",confirmed),/hash mismatch/);
    value=.4;identity="first";digest="mode-a";
  }
  assert.equal((await service.call("set_device_parameter_display",confirmed)).observed.verified,true);
  await assert.rejects(service.call("set_device_parameter_display",confirmed));assert.equal(writes,1);
});

test("native display boundary rejects malformed identifiers, unsupported targets and inconsistent bridge context",async()=>{
  validateToolArguments("set_device_parameter_display",args);
  const service=new ToolService({bridge:{request:async()=>{throw Error("unexpected bridge call");}}});
  for(const input of [{...args,parameterId:"parameter-01"},{...args,deviceId:"track-1:device-0"},{...args,targetDisplay:"2 MHz"},
    {...args,targetDisplay:"1,000 Hz"},{...args,targetDisplay:"NaN Hz"}])await assert.rejects(service.call("set_device_parameter_display",input),/canonical|unit|display/);
  const stale=new ToolService({bridge:{request:async()=>({stateVersion:4,identityToken:"old",trackId:"track-9",deviceId:args.deviceId,parameterId:args.parameterId,target:{value:.5}})}});
  await assert.rejects(stale.call("set_device_parameter_display",args),/mismatch/);
});

test("native display tool is excluded from core and exposed through the full MCP boundary",async()=>{
  const service=new ToolService({bridge:{request:async()=>{throw Error("native refused unsupported parameter");}}});
  const all=createRouter(service),core=createRouter(service,{toolProfile:"core"});
  assert.ok((await all({id:1,method:"tools/list"})).result.tools.some(t=>t.name==="set_device_parameter_display"));
  assert.equal((await core({id:2,method:"tools/call",params:{name:"set_device_parameter_display",arguments:args}})).error.code,-32601);
  assert.equal((await all({id:3,method:"tools/call",params:{name:"set_device_parameter_display",arguments:args}})).result.isError,true);
});
