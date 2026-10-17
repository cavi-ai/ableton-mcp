import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

function fixture(){
 const calls=[],args={trackId:'track-0',clipId:'track-0:clip-0',durationSeconds:2,expectedStateVersion:4};
 const source={stateVersion:4,trackId:args.trackId,clipId:args.clipId,identityToken:'clip-a',clip:{launchMode:{value:1,name:'gate'}}};
 const finishSource={stateVersion:5,holdId:'hold-a',identityToken:'hold-a',status:'active'};
 const handle={...finishSource,releaseCallReturned:false,buttonStateVerified:false};
 const service=new ToolService({bridge:{request:async(method,params)=>{
  calls.push({method,params});
  if(method==='get_session_clip_hold_source')return structuredClone(params.holdId?finishSource:source);
  if(method==='hold_session_clip')return {...handle,pressCallReturned:true};
  if(method==='get_session_clip_hold')return params.holdId?structuredClone(handle):{stateVersion:5,holds:[structuredClone(handle)]};
  if(method==='finish_session_clip_hold')return {...handle,status:'cancelled',releaseCallReturned:true,handleReleased:true};
  throw Error(method);
 }}});
 return {service,calls,args,source,finishSource,handle};
}

test('hold planning is inert and confirmation binds exact native context',async()=>{
 const f=fixture(),p=await f.service.call('hold_session_clip',f.args);
 assert.equal(p.dryRun,true);assert.equal(f.calls.length,1);assert.match(p.warning,/display ticks|wall.clock/);
 const confirmed={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 const result=await f.service.call('hold_session_clip',confirmed);
 assert.equal(result.observed.pressCallReturned,true);assert.equal(result.observed.buttonStateVerified,false);
 await assert.rejects(()=>f.service.call('hold_session_clip',confirmed),/confirmation/);
 assert.equal(f.calls.filter(x=>x.method==='hold_session_clip').length,1);
});

test('replacement and invalid hold arguments never issue a press',async()=>{
 const f=fixture(),p=await f.service.call('hold_session_clip',f.args);f.source.identityToken='clip-b';
 await assert.rejects(()=>f.service.call('hold_session_clip',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}),/hash|changed/);
 for(const durationSeconds of [.1,9,NaN,true])await assert.rejects(()=>f.service.call('hold_session_clip',{...f.args,durationSeconds}),/duration/);
 await assert.rejects(()=>f.service.call('hold_session_clip',{...f.args,allowPlaying:'yes'}),/allowPlaying/);
 assert.equal(f.calls.filter(x=>x.method==='hold_session_clip').length,0);
});

test('reconnect lists holds and early release uses stable native finish context',async()=>{
 const f=fixture();assert.equal((await f.service.call('get_session_clip_hold',{})).holds[0].holdId,'hold-a');
 const args={holdId:'hold-a',cancel:true,expectedStateVersion:5},p=await f.service.call('finish_session_clip_hold',args);
 f.handle.isPlaying=true;
 const result=await f.service.call('finish_session_clip_hold',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
 assert.equal(result.observed.releaseCallReturned,true);assert.equal(result.observed.handleReleased,true);
});

test('hold tools validate at the MCP boundary and leave the core profile unchanged',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 const tools=(await all({id:1,method:'tools/list'})).result.tools;
 for(const name of ['hold_session_clip','get_session_clip_hold','finish_session_clip_hold'])assert.ok(tools.some(t=>t.name===name));
 assert.equal(tools.find(t=>t.name==='get_session_clip_hold').annotations.readOnlyHint,true);
 assert.ok(!(await core({id:2,method:'tools/list'})).result.tools.some(t=>t.name==='hold_session_clip'));
 const callsBeforeInvalid=f.calls.length;
 const result=await all({id:3,method:'tools/call',params:{name:'hold_session_clip',arguments:{...f.args,durationSeconds:9}}});
 assert.equal(result.error.code,-32602);assert.equal(f.calls.length,callsBeforeInvalid);
});

test('held performance workflow separates release receipts from playback and manual input',()=>{
 const text=getPrompt('perform-session-clip',{request:'Hold the selected Gate clip for two seconds.'}).messages[0].content.text;
 for(const name of ['hold_session_clip','get_session_clip_hold','finish_session_clip_hold','releaseCallReturned'])assert.ok(text.includes(name),name);
 assert.match(text,/manual|controller/);assert.match(text,/Repeat.*continu|continu.*Repeat/s);
});
