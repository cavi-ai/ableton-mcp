import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

test('native A/B confirmation signs current context and requires explicit other-slot overwrite',async()=>{
  let digest='original',writes=0;
  const target={trackId:'track-0',deviceId:'track-0:device-0'},before=()=>({stateVersion:3,...target,supported:true,canCopy:true,activeSlot:'A',
    identityToken:'native-device',parametersDigest:digest,otherSlotContentsAvailable:false});
  const service=new ToolService({bridge:{request:async(method,args)=>{
    if(method==='get_device_ab_context')return before();
    writes++;assert.equal(method,'copy_device_ab_slot');assert.equal(args.overwriteOtherSlot,true);
    return {stateVersion:4,...target,copyRequested:true,copyVerified:false};
  }}});
  const args={...target,expectedStateVersion:3};
  await assert.rejects(()=>service.call('copy_device_ab_slot',args),/overwrite/i);
  const plan=await service.call('copy_device_ab_slot',{...args,overwriteOtherSlot:true});
  assert.match(plan.plan.warning,/automation/i);
  digest='manual-edit';await assert.rejects(()=>service.call('copy_device_ab_slot',{...args,overwriteOtherSlot:true,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}),/mismatch|changed/i);
  assert.equal(writes,0);digest='original';
  const result=await service.call('copy_device_ab_slot',{...args,overwriteOtherSlot:true,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  assert.equal(result.observed.copyVerified,false);assert.equal(writes,1);
});

test('A/B tools remain outside core and the workflow distinguishes hidden state from slot readback',async()=>{
  const service=new ToolService({bridge:{request:async()=>({supported:false})}}),all=createRouter(service),core=createRouter(service,{toolProfile:'core'});
  const tools=(await all({id:1,method:'tools/list'})).result.tools;
  assert.equal(tools.find(x=>x.name==='get_device_ab_context').annotations.readOnlyHint,true);
  for(const name of ['get_device_ab_context','copy_device_ab_slot','select_device_ab_slot'])assert.equal((await core({id:2,method:'tools/call',params:{name,arguments:{}}})).error.code,-32601);
  const text=getPrompt('compare-device-ab',{request:'Compare two filter settings and keep my notes'}).messages[0].content.text;
  for(const term of ['get_device_ab_context','copy_device_ab_slot','select_device_ab_slot','overwriteOtherSlot','copyVerified','slotVerified'])assert.ok(text.includes(term),term);
  assert.match(text,/hidden/i);assert.match(text,/manual edits/i);assert.match(text,/never.*retry blindly/i);
});
