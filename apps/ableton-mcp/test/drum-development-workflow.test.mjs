import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/server.mjs';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';

const service = () => new ToolService({bridge:{request:async()=>{throw Error('workflow retrieval must not call Live');}}});

test('drum development is available through MCP prompts and producer workflow retrieval without Live',async()=>{
  const route=createRouter(service(),{toolProfile:'producer'});
  const listed=await route({id:1,method:'tools/call',params:{name:'get_producer_workflow',arguments:{}}});
  assert.ok(listed.result.structuredContent.workflows.some(x=>x.name==='develop-drum-part'));
  const args={request:'Keep the kick and snare, thin the hats, then add a final-bar fill on a copy.'};
  const prompt=await route({id:2,method:'prompts/get',params:{name:'develop-drum-part',arguments:args}});
  const tool=await route({id:3,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'develop-drum-part',arguments:args}}});
  assert.equal(prompt.error,undefined);
  assert.deepEqual(tool.result.structuredContent,{workflow:'develop-drum-part',...prompt.result});
  assert.match(prompt.result.messages[0].content.text,/Mode: collaborative/);
});

test('drum development validates its brief and decision mode on both retrieval paths',async()=>{
  const route=createRouter(service(),{toolProfile:'producer'});
  for(const args of [{},{request:3},{request:'Fill',mode:'replace-original'},{request:'Fill',extra:'yes'}]){
    const result=await route({id:1,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'develop-drum-part',arguments:args}}});
    assert.ok(result.error||result.result?.isError,JSON.stringify(args));
  }
  assert.throws(()=>getPrompt('develop-drum-part',{request:'Fill',mode:'replace-original'}),/mode/);
  assert.match(getPrompt('develop-drum-part',{request:'Choose a sparse fill',mode:'autonomous'}).messages[0].content.text,/Mode: autonomous/);
});

test('drum development instructions resolve actual lanes, distinguish edit semantics and preserve user work',()=>{
  const text=getPrompt('develop-drum-part',{request:'Make the ending less repetitive'}).messages[0].content.text;
  for(const tool of ['get_device_hierarchy','get_midi_clip_notes_extended','get_clip_timing','get_song_grid_reference','duplicate_clip','plan_drum_pattern_edit','edit_drum_pattern_clip','plan_drum_variation','apply_drum_variation','launch_clip'])assert.ok(text.includes(tool),tool);
  assert.match(text,/General MIDI.*not.*mapping/i);
  assert.match(text,/zero-based.*startBar/);
  assert.match(text,/one-based.*activeSteps/);
  assert.match(text,/clip.*meter/i);
  assert.match(text,/preserveAccentsAbove.*velocity.*not.*timing/i);
  assert.match(text,/fill.*adds.*not.*replace/i);
  assert.match(text,/manual edits/i);
  assert.match(text,/lost reply/i);
  assert.match(text,/complete.*note.*readback/i);
  assert.match(text,/duplicate_clip.*destinationClipId/);
  assert.match(text,/does not.*musical quality/i);
});
