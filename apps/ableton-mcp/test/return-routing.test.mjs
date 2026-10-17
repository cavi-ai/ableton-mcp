import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {toolContracts} from '../src/tool-contracts.mjs';
import {getPrompt} from '../src/prompts.mjs';

test('Return routing is a read-only all-profile tool that forwards only the exact Return ID',async()=>{
 const calls=[],record={stateVersion:3,returnTrackId:'return-2',name:'C-Room',output:{supported:false,type:null,channel:null,availableTypes:[],availableChannels:[]}};
 const service=new ToolService({bridge:{request:async(method,args)=>{calls.push({method,args});return record;}}}),all=createRouter(service),core=createRouter(service,{toolProfile:'core'});
 const tool=(await all({id:1,method:'tools/list'})).result.tools.find(t=>t.name==='get_return_routing');
 assert.equal(tool?.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
 calls.length=0;
 const response=await all({id:2,method:'tools/call',params:{name:'get_return_routing',arguments:{returnTrackId:'return-2'}}});
 assert.deepEqual(response.result.structuredContent,record);assert.deepEqual(calls,[{method:'get_return_routing',args:{returnTrackId:'return-2'}}]);
 assert.equal((await core({id:3,method:'tools/call',params:{name:'get_return_routing',arguments:{returnTrackId:'return-2'}}})).error.code,-32601);
 const invalid=await all({id:4,method:'tools/call',params:{name:'get_return_routing',arguments:{returnTrackId:'return-2',dryRun:false}}});assert.ok(invalid.error);assert.equal(calls.length,1);
});

test('shared Return workflow resolves parallel routing and validates modes without calling Live',async()=>{
 const service=new ToolService({bridge:{request:async()=>{throw Error('workflow retrieval must not call Live');}}});
 for(const mode of [undefined,'collaborative','autonomous']){
  const args={request:'Send Chords and Bass to one new room reverb.',...(mode?{mode}:{})},result=await service.call('get_producer_workflow',{workflow:'build-shared-return-effect',arguments:args});
  assert.deepEqual(result.messages,getPrompt('build-shared-return-effect',args).messages);
  for(const name of new Set(result.messages[0].content.text.match(/\b[a-z]+(?:_[a-z]+)+\b/g)))assert.ok(Object.hasOwn(toolContracts,name),`public workflow tool: ${name}`);
 }
 await assert.rejects(service.call('get_producer_workflow',{workflow:'build-shared-return-effect',arguments:{request:'reverb',mode:'unknown'}}));
});
