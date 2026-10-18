import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/server.mjs';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';

test('MIDI simplification is discoverable and identical through prompts and producer tools without Live',async()=>{
  const route=createRouter(new ToolService({bridge:{request:async()=>{throw Error('workflow retrieval must not call Live');}}}),{toolProfile:'producer'});
  const listed=await route({id:1,method:'tools/call',params:{name:'get_producer_workflow',arguments:{}}});
  assert.ok(listed.result.structuredContent.workflows.some(x=>x.name==='simplify-midi-part'));
  const args={request:'Leave more space in the verse hats; keep the kick, snare and first-bar pickup.'};
  const prompt=await route({id:2,method:'prompts/get',params:{name:'simplify-midi-part',arguments:args}});
  const tool=await route({id:3,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'simplify-midi-part',arguments:args}}});
  assert.deepEqual(tool.result.structuredContent,{workflow:'simplify-midi-part',...prompt.result});
  assert.match(prompt.result.messages[0].content.text,/Mode: collaborative/);
  assert.ok(prompt.result.messages[0].content.text.includes(args.request));
});

test('MIDI simplification rejects missing requests and unknown decision modes',async()=>{
  const route=createRouter(new ToolService({bridge:{request:async()=>{throw Error('no Live calls');}}}),{toolProfile:'producer'});
  for(const args of [{},{request:'Simplify',mode:'overwrite'}]){
    const result=await route({id:1,method:'prompts/get',params:{name:'simplify-midi-part',arguments:args}});
    assert.equal(result.error?.code,-32602);
  }
  for(const args of [{request:3},{request:'Simplify',unexpected:'yes'}]){
    const result=await route({id:2,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'simplify-midi-part',arguments:args}}});
    assert.ok(result.error||result.result?.isError);
  }
  assert.match(getPrompt('simplify-midi-part',{request:'Choose a sparse alternative within the brief',mode:'autonomous'}).messages[0].content.text,/Mode: autonomous/);
});
