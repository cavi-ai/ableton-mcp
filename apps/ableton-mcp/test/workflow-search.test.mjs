import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {listPrompts,getPrompt} from '../src/prompts.mjs';

function service(){return new ToolService({bridge:{request:async()=>{throw Error('workflow search must not call Live');}}});}

test('workflow keyword search finds exact names and plain requests without executing Live',async()=>{
 const tools=service();
 for(const [query,expected] of [['diagnose-silent-part','diagnose-silent-part'],['Why is my part silent?','diagnose-silent-part'],['record Session take','record-session-take']]){
  const result=await tools.call('get_producer_workflow',{query});
  assert.equal(result.workflows[0].name,expected);assert.ok(result.workflows.length<=5);
  for(const {matchedTerms,...descriptor} of result.workflows){
   assert.deepEqual(descriptor,listPrompts().find(x=>x.name===descriptor.name));
   assert.ok(matchedTerms.length>0);assert.ok(matchedTerms.every(term=>result.terms.includes(term)));
  }
 }
 const result=await tools.call('get_producer_workflow',{workflow:'diagnose-silent-part',arguments:{request:'Inspect my bass without changing it.'}});
 const prompt=getPrompt('diagnose-silent-part',{request:'Inspect my bass without changing it.'});
 assert.deepEqual(result,{workflow:'diagnose-silent-part',...prompt});
});

test('workflow search is bounded, deterministic and explicit about empty or partial matches',async()=>{
 const tools=service(),all=await tools.call('get_producer_workflow',{});
 assert.deepEqual(all,{workflows:listPrompts()});
 const limited=await tools.call('get_producer_workflow',{query:'MIDI',limit:2});
 assert.equal(limited.workflows.length,2);assert.ok(limited.totalMatches>2);assert.equal(limited.truncated,true);
 assert.deepEqual(await tools.call('get_producer_workflow',{query:'MIDI',limit:2}),limited);
 const none=await tools.call('get_producer_workflow',{query:'zqxvblorb'});
 assert.deepEqual(none.workflows,[]);assert.equal(none.totalMatches,0);assert.equal(none.truncated,false);
 const partial=await tools.call('get_producer_workflow',{query:'silent zqxvblorb'});
 assert.equal(partial.workflows[0].name,'diagnose-silent-part');assert.deepEqual(partial.workflows[0].matchedTerms,['silent']);
 assert.ok(JSON.stringify(limited).length<JSON.stringify(all).length/4);
});

test('workflow search validates request bounds and keeps search separate from rendering',async()=>{
 const tools=service();
 for(const args of [{query:''},{query:'   '},{query:7},{query:'a'.repeat(201)},{query:'please help me'},
  {query:'MIDI',limit:0},{query:'MIDI',limit:21},{query:'MIDI',limit:1.5},{query:'MIDI',limit:true},{limit:2},
  {query:'MIDI',arguments:{request:'unused'}},{query:'silent',workflow:'diagnose-silent-part',arguments:{request:'inspect'}},
  {limit:2,workflow:'diagnose-silent-part',arguments:{request:'inspect'}}])
  await assert.rejects(tools.call('get_producer_workflow',args),JSON.stringify(args));
});

test('workflow search is advertised and available in all and producer profiles only',async()=>{
 for(const toolProfile of ['all','producer']){
  const router=createRouter(service(),{toolProfile});
  const listing=await router({id:1,method:'tools/list'}),tool=listing.result.tools.find(x=>x.name==='get_producer_workflow');
  assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.inputSchema.properties.query.maxLength,200);
  const result=await router({id:2,method:'tools/call',params:{name:'get_producer_workflow',arguments:{query:'silent part',limit:1}}});
  assert.equal(result.result.structuredContent.workflows[0].name,'diagnose-silent-part');
  for(const args of [{query:'MIDI',limit:21},{query:42}]){
   const invalid=await router({id:3,method:'tools/call',params:{name:'get_producer_workflow',arguments:args}});
   assert.ok(invalid.error||invalid.result?.isError);
  }
 }
});
