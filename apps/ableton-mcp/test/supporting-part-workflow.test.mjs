import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/server.mjs';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';

test('supporting-part workflow is discoverable through prompts and producer tools without Live',async()=>{
  const service=new ToolService({bridge:{request:async()=>{throw Error('retrieving a workflow must not call Live');}}});
  const route=createRouter(service,{toolProfile:'producer'});
  const listed=await route({id:1,method:'tools/call',params:{name:'get_producer_workflow',arguments:{}}});
  assert.ok(listed.result.structuredContent.workflows.some(x=>x.name==='write-supporting-part'));
  const args={request:'Write bass under the verse chords, keep their timing and leave playback stopped.'};
  const direct=await route({id:2,method:'prompts/get',params:{name:'write-supporting-part',arguments:args}});
  const tool=await route({id:3,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'write-supporting-part',arguments:args}}});
  assert.deepEqual(tool.result.structuredContent,{workflow:'write-supporting-part',...direct.result});
  assert.match(direct.result.messages[0].content.text,/Mode: collaborative/);
});

test('supporting-part request and decision mode are validated before returning instructions',async()=>{
  const route=createRouter({call:async()=>{throw Error('no Live calls');}});
  for(const args of [{},{request:'Bass',mode:'silent-overwrite'}]){
    const result=await route({id:1,method:'prompts/get',params:{name:'write-supporting-part',arguments:args}});
    assert.equal(result.error?.code,-32602);
  }
  const tools=createRouter(new ToolService({bridge:{request:async()=>{throw Error('no Live calls');}}}),{toolProfile:'producer'});
  for(const args of [{request:3},{request:'Bass',unknown:'yes'}]){
    const result=await tools({id:2,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'write-supporting-part',arguments:args}}});
    assert.ok(result.error||result.result?.isError);
  }
  assert.match(getPrompt('write-supporting-part',{request:'Choose a complementary bass line within these chords',mode:'autonomous'}).messages[0].content.text,/Mode: autonomous/);
});

test('supporting-part instructions ground new notes in a shared passage and preserve manual work',()=>{
  const text=getPrompt('write-supporting-part',{request:'Add a counter-melody to the selected passage'}).messages[0].content.text;
  for(const tool of ['analyze_arrangement_section','includeHarmony','get_midi_clip_notes_extended','get_clip_timing','create_midi_clip','place_session_clip_in_arrangement','audition_arrangement_passage'])assert.ok(text.includes(tool),tool);
  assert.match(text,/Session.*phase/i);
  assert.match(text,/configured scale.*not.*detected key/i);
  assert.match(text,/ambiguous/i);
  assert.match(text,/manual edits/i);
  assert.match(text,/lost reply/i);
  assert.match(text,/complete.*note.*readback/i);
  assert.match(text,/new.*track/i);
  assert.match(text,/does not.*musical quality/i);
});
