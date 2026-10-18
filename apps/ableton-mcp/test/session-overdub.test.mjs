import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getProducerWorkflow} from '../src/prompts.mjs';

function fixture(){
  const source={stateVersion:3,trackId:'track-0',clipId:'track-0:clip-0',identityToken:'native',sessionRecord:false,baseline:{notesSha256:'a'}};
  const writes=[];
  const service=new ToolService({bridge:{request:async(method,args)=>{
    if(method==='get_session_midi_overdub_context')return structuredClone(source);
    if(method==='set_session_midi_overdub'){writes.push(args);return {nativeReturned:true,sessionRecordVerified:true,performanceVerified:false};}
    throw Error(method);
  }}});
  return {source,writes,service,args:{trackId:source.trackId,clipId:source.clipId,enabled:true,expectedStateVersion:3}};
}

test('Session overdub confirms exact source once and distinguishes the recording switch from performance',async()=>{
  const f=fixture(),p=await f.service.call('set_session_midi_overdub',f.args);
  assert.equal(f.writes.length,0);assert.match(p.warning,/disconnect/);assert.match(p.warning,/stop/);
  const input={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
  const result=await f.service.call('set_session_midi_overdub',input);
  assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].before,f.source);
  assert.equal(result.observed.performanceVerified,false);
  await assert.rejects(f.service.call('set_session_midi_overdub',input),/confirmation/);
});

test('changed source, replacement, wrong state and invalid toggle never reach the native write',async()=>{
  for(const change of [f=>f.source.identityToken='replacement',f=>f.source.baseline.notesSha256='b',f=>f.source.stateVersion++]){
    const f=fixture(),p=await f.service.call('set_session_midi_overdub',f.args);change(f);
    await assert.rejects(f.service.call('set_session_midi_overdub',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}),/changed|hash/);
    assert.equal(f.writes.length,0);
  }
  for(const enabled of [1,'true',null,undefined]){
    const f=fixture();await assert.rejects(f.service.call('set_session_midi_overdub',{...f.args,enabled}),/boolean/);assert.equal(f.writes.length,0);
  }
});

test('reconnected clients can read the current target and explicitly stop without an old runtime handle',async()=>{
  const f=fixture();f.source.sessionRecord=true;f.source.baseline=null;
  const context=await f.service.call('get_session_midi_overdub_context',{trackId:f.args.trackId,clipId:f.args.clipId});
  assert.equal(context.sessionRecord,true);
  const args={...f.args,enabled:false},p=await f.service.call('set_session_midi_overdub',args);
  await f.service.call('set_session_midi_overdub',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
  assert.equal(f.writes[0].enabled,false);
});

test('overdub contracts are all-profile only with strict booleans and a read-only context',async()=>{
  const f=fixture(),router=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
  const all=(await router({id:1,method:'tools/list'})).result.tools;
  assert.equal(all.find(t=>t.name==='get_session_midi_overdub_context').annotations.readOnlyHint,true);
  assert.ok(!(await core({id:2,method:'tools/list'})).result.tools.some(t=>t.name==='set_session_midi_overdub'));
  const result=await router({id:3,method:'tools/call',params:{name:'set_session_midi_overdub',arguments:{...f.args,enabled:'true'}}});
  assert.equal(result.error.code,-32602);assert.equal(f.writes.length,0);
});

test('interactive overdub workflow preserves originals and reconciles a lost start instead of replaying',()=>{
  const result=getProducerWorkflow({workflow:'overdub-session-midi',arguments:{request:'Add a shaker performance to this loop'}});
  const text=result.messages[0].content.text;
  for(const term of ['duplicate_clip','set_session_midi_overdub','get_session_midi_overdub_context','session_record','disconnect','original','manual edits','performanceVerified'])assert.ok(text.includes(term),term);
  assert.match(text,/same-pitch/);assert.match(text,/never replay/i);assert.match(text,/not.*fixed|no.*fixed/i);
});
