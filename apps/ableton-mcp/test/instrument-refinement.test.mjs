import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {getPrompt} from "../src/prompts.mjs";

test("parameter confirmation binds observed automation ownership and invalidates a changed state",async()=>{
  const parameter={id:"parameter-0",name:"Cutoff",originalName:"Cutoff",value:0.5,min:0,max:1,enabled:true,
    displayValue:"50%",quantized:false,valueItems:[],automationState:{value:0,name:"none"}},writes=[],editContext={identityToken:"native-device-a",deviceClass:"UltraAnalog"};
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(["list_device_parameters","get_device_parameter_edit_context"].includes(method))return {stateVersion:4,trackId:params.trackId,deviceId:params.deviceId,editContext:structuredClone(editContext),parameters:[structuredClone(parameter)]};
    if(method==="set_device_parameters"){writes.push(params);return {stateVersion:5,trackId:params.trackId,deviceId:params.deviceId,observedChanges:[{...parameter,value:0.4}]};}
    throw Error(method);
  }}});
  const args={trackId:"track-0",deviceId:"track-0:device-0",expectedStateVersion:4,changes:[{id:"parameter-0",value:0.4}]};
  const plan=await service.call("set_device_parameters",args);
  assert.deepEqual(plan.plan.changes[0].previousAutomationState,parameter.automationState);
  assert.deepEqual(plan.plan.beforeEditContext,editContext);
  parameter.automationState={value:1,name:"playing"};
  await assert.rejects(service.call("set_device_parameters",{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));
  assert.equal(writes.length,0);
  parameter.automationState={value:0,name:"none"};
  const fresh=await service.call("set_device_parameters",args);editContext.identityToken="native-device-b";
  await assert.rejects(service.call("set_device_parameters",{...args,dryRun:false,confirmationToken:fresh.confirmation.token,planHash:fresh.confirmation.planHash}));
  assert.equal(writes.length,0);
});
test("sound refinement is available through the same workflow tool and MCP prompt with validated modes",async()=>{
  const service=new ToolService({bridge:{request:async()=>{throw Error("retrieval must not call Live");}}});
  for(const mode of [undefined,"compare","in-place"]){
    const args={request:"Make the named Analog chords a little warmer; preserve my notes.",...(mode?{mode}:{})};
    const result=await service.call("get_producer_workflow",{workflow:"refine-instrument-sound",arguments:args});
    assert.deepEqual(result.messages,getPrompt("refine-instrument-sound",args).messages);
  }
  await assert.rejects(service.call("get_producer_workflow",{workflow:"refine-instrument-sound",arguments:{request:"Warmer",mode:"replace"}}));
});
