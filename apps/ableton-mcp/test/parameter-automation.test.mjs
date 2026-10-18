import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

function fixture(){
 const before={stateVersion:4,setFingerprint:'set',trackId:'track-0',deviceId:null,parameterId:'volume',identityToken:'native',
  ownerType:'midi',frozen:false,transport:{isPlaying:true,arrangementRecord:false,sessionRecord:false,countingIn:false},panningMode:null,
  controls:[{id:'volume',supported:true,reEnableSupported:true,value:.5,min:0,max:1,enabled:true,quantized:false,automationState:{value:2,name:'overridden'}}]};
 const calls=[],service=new ToolService({bridge:{request:async(method,args)=>{
  calls.push({method,args});if(method==='get_parameter_automation_context')return structuredClone(before);
  if(method==='re_enable_parameter_automation')return {verified:true,reEnableRequested:true,automationControlRestored:true};
  throw Error(method);
 }}});
 return {before,calls,service,args:{trackId:'track-0',parameterId:'volume',expectedStateVersion:4}};
}

test('automation context and handoff planning are inert; exact confirmation calls native once',async()=>{
 const f=fixture();assert.equal((await f.service.call('get_parameter_automation_context',{trackId:'track-0'})).trackId,'track-0');
 const p=await f.service.call('re_enable_parameter_automation',f.args);
 assert.equal(f.calls.filter(x=>x.method==='re_enable_parameter_automation').length,0);
 const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 assert.equal((await f.service.call('re_enable_parameter_automation',args)).observed.verified,true);
 await assert.rejects(()=>f.service.call('re_enable_parameter_automation',args),/confirmation/);
 assert.equal(f.calls.filter(x=>x.method==='re_enable_parameter_automation').length,1);
});

test('manual value, identity, automation and mode changes invalidate a same-version handoff plan',async()=>{
 for(const change of [f=>f.before.identityToken='replacement',f=>f.before.controls[0].value=.6,
  f=>f.before.controls[0].automationState={value:1,name:'playing'},f=>f.before.transport.isPlaying=false]){
  const f=fixture(),p=await f.service.call('re_enable_parameter_automation',f.args);change(f);
  await assert.rejects(()=>f.service.call('re_enable_parameter_automation',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.calls.filter(x=>x.method==='re_enable_parameter_automation').length,0);
 }
});

test('unavailable API, unsafe controls and mismatched native target refuse before handoff',async()=>{
 for(const change of [f=>f.before.controls[0].reEnableSupported=false,f=>f.before.controls[0].enabled=false,
  f=>f.before.frozen=null,f=>f.before.transport.arrangementRecord=true,f=>f.before.transport.countingIn=true,
  f=>f.before.trackId='track-1',f=>f.before.parameterId='pan',f=>f.before.controls[0].automationState=null]){
  const f=fixture();change(f);
  await assert.rejects(()=>f.service.call('re_enable_parameter_automation',f.args));
  assert.equal(f.calls.filter(x=>x.method==='re_enable_parameter_automation').length,0);
 }
});

test('Return and Main plans warn about their stage while arbitrary fields and selectors refuse',async()=>{
 for(const trackId of ['return-0','master']){
  const f=fixture();Object.assign(f.before,{trackId,ownerType:trackId==='master'?'master':'return'});
  const result=await f.service.call('re_enable_parameter_automation',{...f.args,trackId});assert.match(result.warning,/Return|Main/);
 }
 const f=fixture();await assert.rejects(()=>f.service.call('re_enable_parameter_automation',{...f.args,trackId:'track-00'}));
 const route=createRouter(f.service);
 const invalid=await route({id:1,method:'tools/call',params:{name:'re_enable_parameter_automation',arguments:{...f.args,allParameters:true}}});
 assert.equal(invalid.error.code,-32602);
});

test('handoff tools remain all-profile and workflow preserves unrelated overrides and ongoing playback',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 const tools=(await all({id:1,method:'tools/list'})).result.tools;
 assert.equal(tools.find(t=>t.name==='get_parameter_automation_context').annotations.readOnlyHint,true);
 assert.ok(tools.some(t=>t.name==='re_enable_parameter_automation'));
 const unavailable=await core({id:2,method:'tools/call',params:{name:'get_parameter_automation_context',arguments:{trackId:'track-0'}}});
 assert.equal(unavailable.error.code,-32601);
 const text=getPrompt('resume-parameter-automation',{request:'Give this filter back to automation'}).messages[0].content.text;
 for(const term of ['get_parameter_automation_context','re_enable_parameter_automation','overridden','unrelated','playback','partial','audible'])assert.ok(text.includes(term),term);
});
