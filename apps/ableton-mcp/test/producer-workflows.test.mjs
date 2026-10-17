import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {getPrompt,listPrompts} from "../src/prompts.mjs";
import {toolContracts} from "../src/tool-contracts.mjs";

function service() {
  return new ToolService({bridge:{request:async()=>{throw Error("workflow retrieval must not call Live");}}});
}

test("workflow tool lists canonical prompts and renders the same instructions without executing them",async()=>{
  const tools=service(),listed=await tools.call("get_producer_workflow",{});
  assert.deepEqual(listed.workflows,listPrompts());
  for(const mode of [undefined,"collaborative","autonomous"]){
    const args={request:"Create a four-bar idea; keep my existing work.",...(mode?{mode}:{})};
    const result=await tools.call("get_producer_workflow",{workflow:"create-musical-sketch",arguments:args});
    assert.equal(result.workflow,"create-musical-sketch");
    const prompt=getPrompt("create-musical-sketch",args);
    assert.deepEqual({description:result.description,messages:result.messages},prompt);
  }
});

test("workflow tool rejects missing, unknown and malformed arguments before returning instructions",async()=>{
  const tools=service();
  for(const args of [
    {arguments:{request:"unused"}},
    {workflow:"unknown"},
    {workflow:"create-musical-sketch"},
    {workflow:"create-musical-sketch",arguments:{request:"idea",unexpected:"value"}},
    {workflow:"create-musical-sketch",arguments:{request:{text:"idea"}}},
    {workflow:"create-musical-sketch",arguments:{request:"idea",mode:"anything"}}
  ])await assert.rejects(tools.call("get_producer_workflow",args));
});

test("sidechain workflow is discoverable and renders both interaction modes without calling Live",async()=>{
  const tools=service(),name="set-up-sidechain-ducking";
  assert.ok((await tools.call("get_producer_workflow",{})).workflows.some(w=>w.name===name));
  for(const mode of [undefined,"collaborative","autonomous"]){
    const args={request:"Duck my bass from the kick; preserve an alternative.",...(mode?{mode}:{})};
    const result=await tools.call("get_producer_workflow",{workflow:name,arguments:args});
    const prompt=getPrompt(name,args);
    assert.deepEqual({description:result.description,messages:result.messages},prompt);
    assert.match(result.messages[0].content.text,/Duck my bass from the kick/);
    for(const name of new Set(result.messages[0].content.text.match(/\b[a-z]+(?:_[a-z]+)+\b/g)))
      assert.ok(Object.hasOwn(toolContracts,name),`workflow references a public tool: ${name}`);
  }
  for(const args of [{},{request:"duck",mode:"unknown"},{request:"duck",sourceTrackId:"track-1"}])
    await assert.rejects(tools.call("get_producer_workflow",{workflow:name,arguments:args}));
});

test("workflow discovery is read-only in all and unavailable in core; invalid calls fail at the MCP boundary",async()=>{
  const all=createRouter(service()),core=createRouter(service(),{toolProfile:"core"});
  const tool=(await all({id:1,method:"tools/list"})).result.tools.find(t=>t.name==="get_producer_workflow");
  assert.equal(tool.annotations.readOnlyHint,true);
  assert.equal(tool.annotations.destructiveHint,false);
  assert.deepEqual(tool.inputSchema.properties.workflow.enum,listPrompts().map(p=>p.name));
  assert.equal((await core({id:2,method:"tools/call",params:{name:"get_producer_workflow",arguments:{}}})).error.code,-32601);
  const invalid=await all({id:3,method:"tools/call",params:{name:"get_producer_workflow",arguments:{workflow:"create-musical-sketch",arguments:{request:42}}}});
  assert.ok(invalid.error);
});
