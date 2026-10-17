import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

function fixture(){
 const source={stateVersion:4,setFingerprint:'set',identityToken:'native',trackId:'track-0',deviceId:null,parameterId:'volume',
  ownerType:'midi',frozen:false,transport:{isPlaying:true,arrangementRecord:false,sessionRecord:false,countingIn:false},
  controls:[{id:'volume',supported:true,reEnableSupported:true,min:0,max:1,enabled:true,quantized:false,automationState:{value:1,name:'playing'}}],
  valuePolicy:'advancingAutomation',target:{value:.6,displayValue:'600 Hz'},sampledControl:{id:'volume',value:.4,displayValue:'400 Hz'}};
 const calls=[],service=new ToolService({bridge:{request:async(method,args)=>{
  calls.push({method,args});
  if(method==='get_parameter_override_context')return structuredClone(source);
  if(method==='override_parameter_automation')return {stateVersion:5,verified:true,automationOverridden:true,valueWriteRequested:true};
  throw Error(method);
 }}});
 return {source,calls,service,args:{trackId:'track-0',parameterId:'volume',value:.6,expectedStateVersion:4}};
}

test('manual override binds exact targets while active automation observations may advance',async()=>{
 const f=fixture(),plan=await f.service.call('override_parameter_automation',f.args);
 assert.equal(f.calls.filter(c=>c.method==='override_parameter_automation').length,0);
 assert.equal(plan.sampledControl.value,.4);
 assert.equal(plan.plan.before.sampledControl,undefined);
 f.source.sampledControl.value=.5;
 const args={...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 assert.equal((await f.service.call('override_parameter_automation',args)).observed.verified,true);
 await assert.rejects(f.service.call('override_parameter_automation',args),/confirmation/);
 assert.equal(f.calls.filter(c=>c.method==='override_parameter_automation').length,1);
});

test('manual value, ownership, automation and resolved-display changes invalidate confirmation',async()=>{
 for(const change of [f=>f.source.identityToken='replaced',f=>f.source.controls[0].automationState={value:2,name:'overridden'},
  f=>f.source.target.value=.7,f=>f.source.transport.isPlaying=false]){
  const f=fixture(),plan=await f.service.call('override_parameter_automation',f.args);change(f);
  await assert.rejects(f.service.call('override_parameter_automation',{...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));
  assert.equal(f.calls.filter(c=>c.method==='override_parameter_automation').length,0);
 }
 const f=fixture();f.source.valuePolicy='manualValueBound';Object.assign(f.source.controls[0],{value:.4,displayValue:'400 Hz',automationState:{value:2,name:'overridden'}});
 const plan=await f.service.call('override_parameter_automation',f.args);f.source.controls[0].value=.5;
 await assert.rejects(f.service.call('override_parameter_automation',{...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));
});

test('one finite raw value or unit display is required before querying Live',async()=>{
 for(const args of [{value:true},{value:NaN},{value:undefined},{value:undefined,targetDisplay:''},{targetDisplay:'500 Hz'},{trackId:'track-00'}]){
  const f=fixture();await assert.rejects(f.service.call('override_parameter_automation',{...f.args,...args}));assert.equal(f.calls.length,0);
 }
 const f=fixture();f.source.target.quantity={unit:'Hz',value:600};
 const plan=await f.service.call('override_parameter_automation',{...f.args,value:undefined,targetDisplay:'600 Hz'});
 assert.equal(plan.plan.targetDisplay,'600 Hz');assert.equal(plan.plan.value,undefined);
});

test('unsafe or mismatched native contexts cannot issue an override',async()=>{
 for(const change of [f=>f.source.frozen=true,f=>f.source.transport.countingIn=true,f=>f.source.transport.sessionRecord=true,
  f=>f.source.controls[0].enabled=false,f=>f.source.controls[0].automationState={value:0,name:'none'},
  f=>f.source.trackId='track-1',f=>f.source.valuePolicy='unknown',f=>f.source.identityToken=null]){
  const f=fixture();change(f);await assert.rejects(f.service.call('override_parameter_automation',f.args));
  assert.equal(f.calls.filter(c=>c.method==='override_parameter_automation').length,0);
 }
});

test('partial native outcomes remain visible without an automatic retry',async()=>{
 const f=fixture();
 const calls=[],service=new ToolService({bridge:{request:async(method)=>{calls.push(method);return method==='get_parameter_override_context'?structuredClone(f.source):{partial:true,verified:false,valueWriteRequested:true,nativeReturned:false};}}});
 const plan=await service.call('override_parameter_automation',f.args);
 const result=await service.call('override_parameter_automation',{...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
 assert.equal(result.observed.partial,true);assert.equal(calls.filter(m=>m==='override_parameter_automation').length,1);
});

test('override stays all-profile and its workflow requires explicit manual takeover intent',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 const tools=(await all({id:1,method:'tools/list'})).result.tools;assert.ok(tools.some(t=>t.name==='override_parameter_automation'));
 assert.equal((await core({id:2,method:'tools/call',params:{name:'override_parameter_automation',arguments:f.args}})).error.code,-32601);
 const invalid=await all({id:3,method:'tools/call',params:{name:'override_parameter_automation',arguments:{...f.args,targetDisplay:'600 Hz'}}});assert.equal(invalid.error.code,-32602);
 const text=getPrompt('take-manual-control',{request:'Hold the bass filter at 2 kHz until I give it back'}).messages[0].content.text;
 for(const term of ['explicit','override_parameter_automation','re_enable_parameter_automation','recording','unrelated','partial','moving'])assert.ok(text.includes(term),term);
});
