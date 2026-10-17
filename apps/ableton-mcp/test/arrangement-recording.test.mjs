import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

function fixture(){
 const before={stateVersion:4,identityToken:'native-document',trackId:'track-0',controls:{arms:[true,false]},arrangement:[]},calls=[];
 const service=new ToolService({bridge:{async request(method,args){calls.push({method,args});
  if(method==='get_arrangement_recording_source')return structuredClone(before);
  if(method==='record_arrangement_take')return {stateVersion:5,takeId:'take-a',status:'recording',recordingRequested:true,performanceVerified:false};
  if(method==='get_arrangement_take')return {stateVersion:4,takeId:'take-a',status:'recording',controlContext:{recording:true},clips:[{endBeats:Math.random()}]};
  if(method==='finish_arrangement_take')return {stateVersion:5,takeId:'take-a',released:true};
  throw Error(method);
 }}});
 return {before,calls,service,args:{trackId:'track-0',startBeats:8,endBeats:12,expectedStateVersion:4}};
}
const confirm=(args,plan)=>({...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
test('recording is separately confirmed, binds native readiness, and never treats start as a verified performance',async()=>{
 const f=fixture(),p=await f.service.call('record_arrangement_take',f.args);
 assert.equal(p.dryRun,true);assert.equal(f.calls.length,1);
 const result=await f.service.call('record_arrangement_take',confirm(f.args,p));
 assert.equal(result.observed.recordingRequested,true);assert.equal(result.observed.performanceVerified,false);
 await assert.rejects(f.service.call('record_arrangement_take',confirm(f.args,p)),/token/);
});
test('stale native identity and malformed ranges refuse before recording',async()=>{
 const f=fixture(),p=await f.service.call('record_arrangement_take',f.args);f.before.identityToken='replacement';
 await assert.rejects(f.service.call('record_arrangement_take',confirm(f.args,p)),/changed|hash/);
 for(const args of [{startBeats:-1},{endBeats:8},{endBeats:1000},{startBeats:true},{trackId:'master'}])await assert.rejects(f.service.call('record_arrangement_take',{...f.args,...args}));
 assert.equal(f.calls.filter(c=>c.method==='record_arrangement_take').length,0);
});
test('cancel confirmation binds control context without binding the advancing clip edge',async()=>{
 const f=fixture(),args={takeId:'take-a',cancel:true,expectedStateVersion:4},p=await f.service.call('finish_arrangement_take',args);
 assert.equal((await f.service.call('finish_arrangement_take',confirm(args,p))).observed.released,true);
});
test('all profile exposes the read and guarded recording lifecycle with a user workflow',async()=>{
 const f=fixture(),router=createRouter(f.service),tools=(await router({id:1,method:'tools/list'})).result.tools;
 assert.equal(tools.find(t=>t.name==='get_arrangement_take')?.annotations.readOnlyHint,true);
 assert.equal(tools.find(t=>t.name==='record_arrangement_take')?.annotations.readOnlyHint,false);
 assert.ok((await f.service.call('get_producer_workflow',{workflow:'record-arrangement-take',arguments:{request:'Record a four-bar guitar part into empty Arrangement space'}})).messages.length);
 const core=createRouter(f.service,{toolProfile:'core'});assert.ok(!(await core({id:2,method:'tools/list'})).result.tools.some(t=>t.name==='record_arrangement_take'));
});
