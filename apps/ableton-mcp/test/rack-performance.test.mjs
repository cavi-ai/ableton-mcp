import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/server.mjs';
import {ToolService} from '../src/tool-service.mjs';

test('rack performance read is discoverable and uses one native request', async()=>{
  const calls=[];
  const native={stateVersion:3,trackId:'track-0',deviceId:'track-0:device-0',macros:[],mappings:[]};
  const service=new ToolService({bridge:{async request(method,args){calls.push([method,args]);return native;}}});
  const route=createRouter(service,{toolProfile:'all'});
  const listed=await route({id:1,method:'tools/list'});
  const contract=listed.result.tools.find(t=>t.name==='get_rack_performance_context');
  assert.equal(contract?.annotations?.readOnlyHint,true);
  calls.length=0;
  const args={trackId:'track-0',deviceId:'track-0:device-0'};
  const result=await route({id:2,method:'tools/call',params:{name:'get_rack_performance_context',arguments:args}});
  assert.deepEqual(result.result?.structuredContent,native);
  assert.deepEqual(calls,[['get_rack_performance_context',args]]);
});

test('stored variation index follows count increase while selection stays unchanged',async()=>{
  const rack={id:'track-0:device-0',canHaveChains:true,rackMacros:{hasMappings:true,variationCount:2,selectedVariationIndex:-1}};
  const parameters=[{id:'parameter-1',value:64}];
  const service=new ToolService({bridge:{async request(method){
    if(method==='get_device_hierarchy')return {stateVersion:3,trackId:'track-0',device:rack};
    if(method==='list_device_parameters')return {stateVersion:3,trackId:'track-0',deviceId:rack.id,parameters};
    assert.equal(method,'store_rack_macro_variation');
    return {stored:true,device:{...rack,rackMacros:{...rack.rackMacros,variationCount:3}}};
  }}});
  const args={trackId:'track-0',deviceId:rack.id,expectedStateVersion:3};
  const plan=await service.call('store_rack_macro_variation',args);
  const result=await service.call('store_rack_macro_variation',{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  assert.equal(result.observed.storedVariationIndex,2);
  assert.equal(result.observed.device.rackMacros.selectedVariationIndex,-1);
});
