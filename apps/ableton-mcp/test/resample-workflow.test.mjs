import test from 'node:test';
import assert from 'node:assert/strict';
import {getPrompt} from '../src/prompts.mjs';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

test('resampling workflow requires the musical request and rejects invalid modes',()=>{
  assert.throws(()=>getPrompt('resample-to-instrument',{}),error=>error.code===-32602 && /request/.test(error.message));
  assert.throws(()=>getPrompt('resample-to-instrument',{request:'Print the texture',mode:'guess'}),error=>error.code===-32602);
  const rendered=getPrompt('resample-to-instrument',{request:'Print the evolving texture and play it one octave higher',mode:'autonomous'});
  assert.equal(rendered.messages[0].role,'user');
  assert.ok(rendered.messages[0].content.text.includes('Print the evolving texture and play it one octave higher'));
});

test('resampling workflow accepts only bounded numeric capture lengths without silently falling back',()=>{
  for(const captureBeats of ['','0','0.5','17','Infinity','NaN','four','4 bars',4]){
    assert.throws(()=>getPrompt('resample-to-instrument',{request:'Print a texture',captureBeats}),error=>error.code===-32602);
  }
  for(const captureBeats of ['1','4.5','16']){
    const text=getPrompt('resample-to-instrument',{request:'Print a texture',captureBeats}).messages[0].content.text;
    assert.ok(text.includes(`Target capture: ${captureBeats} quarter-note beats`));
  }
});

test('workflow retrieval and MCP prompt rendering do not contact Live',async()=>{
  let calls=0;
  const service=new ToolService({bridge:{request:async()=>{calls++;throw Error('workflow retrieval must not call Live');}}});
  const args={request:'Capture the mix as a new playable pad',captureBeats:'8',mode:'collaborative'};
  const result=await createRouter(service)({id:1,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'resample-to-instrument',arguments:args}}});
  assert.equal(result.result.structuredContent.workflow,'resample-to-instrument');
  const prompt=await createRouter(service,{toolProfile:'core'})({id:2,method:'prompts/get',params:{name:'resample-to-instrument',arguments:args}});
  assert.deepEqual(prompt.result.messages,result.result.structuredContent.messages);
  assert.ok(prompt.result.messages[0].content.text.includes('Target capture: 8 quarter-note beats'));
  assert.equal(calls,0);
});

test('resampling workflow discovery exposes the capture choice and rejects unknown arguments',async()=>{
  const service=new ToolService({bridge:{request:async()=>{throw Error('unexpected bridge call');}}});
  const inventory=await service.call('get_producer_workflow',{}),descriptor=inventory.workflows.find(item=>item.name==='resample-to-instrument');
  assert.equal(descriptor.arguments.find(item=>item.name==='request').required,true);
  assert.equal(descriptor.arguments.find(item=>item.name==='captureBeats').required,false);
  await assert.rejects(service.call('get_producer_workflow',{workflow:'resample-to-instrument',arguments:{request:'Print',silenceOtherTracks:'yes'}}),/unknown/);
});
