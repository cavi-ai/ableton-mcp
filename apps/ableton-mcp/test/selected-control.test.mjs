import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

function fixture(){
 const selection={stateVersion:4,setFingerprint:'set',status:'selected',selectionToken:'native',
  target:{trackId:'track-0',deviceId:'track-0:device-0',parameterId:'parameter-0'},
  control:{value:.4,min:0,max:1,enabled:true,quantized:false,automationState:{value:0,name:'none'}}};
 let writes=0;
 const service=new ToolService({bridge:{async request(method){
  if(method==='get_selected_parameter_context')return structuredClone(selection);
  if(method==='get_selected_parameter_edit_context')return {selection:structuredClone(selection),target:{value:.6,displayValue:'600 Hz'}};
  if(method==='set_selected_parameter'){writes++;return {verified:false,nativeReturned:true,error:'partial',selectionPreserved:false};}
  throw Error(method);
 }}});
 return {selection,service,args:{expectedStateVersion:4,expectedSelectionToken:'native',value:.6},writes:()=>writes};
}
test('selected-control planning is inert, binds exact source and confirms once',async()=>{
 const f=fixture(),p=await f.service.call('set_selected_parameter',f.args);
 assert.equal(f.writes(),0);assert.deepEqual(p.plan.before.selection.target,f.selection.target);
 const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 const result=await f.service.call('set_selected_parameter',args);assert.equal(f.writes(),1);assert.equal(result.observed.verified,false);
 await assert.rejects(f.service.call('set_selected_parameter',args));assert.equal(f.writes(),1);
});
test('manual selection target and value changes reject old confirmed plans',async()=>{
 for(const change of [f=>f.selection.selectionToken='other',f=>f.selection.target.parameterId='parameter-1',f=>f.selection.control.value=.7]){
  const f=fixture(),p=await f.service.call('set_selected_parameter',f.args);change(f);
  await assert.rejects(f.service.call('set_selected_parameter',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.writes(),0);
 }
});
test('unresolved or stale selection never becomes a selected-track fallback',async()=>{
 const f=fixture();
 for(const status of ['none','unavailable','unresolved']){f.selection.status=status;await assert.rejects(f.service.call('set_selected_parameter',f.args));}
 f.selection.status='selected';await assert.rejects(f.service.call('set_selected_parameter',{...f.args,expectedSelectionToken:'stale'}));
 assert.equal(f.writes(),0);
});
test('schema rejects missing mixed or foreign targets and keeps tools in all profile',async()=>{
 const f=fixture(),route=createRouter(f.service);
 for(const args of [{expectedStateVersion:4,value:.6},{...f.args,targetDisplay:'600 Hz'},
  {...f.args,trackId:'track-1'},{...f.args,value:'600 Hz'},{...f.args,expectedSelectionToken:''}]){
  const r=await route({id:1,method:'tools/call',params:{name:'set_selected_parameter',arguments:args}});assert.equal(r.error?.code,-32602);
 }
 const core=createRouter(f.service,{toolProfile:'core'});
 assert.equal((await core({id:1,method:'tools/call',params:{name:'get_selected_parameter_context',arguments:{}}})).error.code,-32601);
 assert.equal(f.writes(),0);
});
