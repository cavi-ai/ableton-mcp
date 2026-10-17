import test from 'node:test';
import assert from 'node:assert/strict';
import {getPrompt} from '../src/prompts.mjs';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
const workflow='print-processed-midi';
test('processed MIDI workflow is discoverable and rendered without native side effects',async()=>{
 let calls=0;const service=new ToolService({bridge:{request:async()=>{calls++;throw Error('retrieval must not operate Live');}}});
 const listed=await service.call('get_producer_workflow',{});assert.ok(listed.workflows.some(w=>w.name===workflow));
 const args={request:'Keep the arpeggiator result as editable notes',recordBeats:'8'},result=await service.call('get_producer_workflow',{workflow,arguments:args});
 assert.deepEqual(result.messages,getPrompt(workflow,args).messages);assert.equal(calls,0);
 const router=createRouter(service),response=await router({id:1,method:'prompts/get',params:{name:workflow,arguments:args}});assert.equal(response.result.messages[0].role,'user');
});
test('invalid recording lengths refuse during discovery before a native request',()=>{
 for(const recordBeats of ['0','-1','65','NaN','4 bars','Infinity',''])assert.throws(()=>getPrompt(workflow,{request:'print',recordBeats}),/recordBeats/);
 for(const recordBeats of ['1','4','8.5','64'])assert.ok(getPrompt(workflow,{request:'print',recordBeats}).messages.length);
 assert.throws(()=>getPrompt(workflow,{}),/request/);
});
