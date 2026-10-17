import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

function fixture(){
 const item={name:'Duet.mid',uri:'query:duet',loadable:true,folder:false},context={stateVersion:4,trackId:'track-0',identityToken:'native-context',item:{...item},tracks:[{id:'track-0',name:'Empty MIDI'}],scenes:[]},writes=[];
 const service=new ToolService({bridge:{request:async(method,args)=>{
  if(method==='list_devices')return {stateVersion:4,trackId:'track-0',devices:[]};
  if(method==='list_clips')return {stateVersion:4,trackId:'track-0',clips:[]};
  if(method==='get_browser_items')return {stateVersion:4,item:{...item}};
  if(method==='get_browser_load_context')return structuredClone(context);
  if(method==='load_browser_item'){writes.push(args);return {nativeLoadReturned:false,loadError:'interrupted',trackEffect:{kind:'inserted',addedTrackIds:['track-1']}};}
  throw Error(method);
 }}});
 const args={trackId:'track-0',root:'user_library',path:['Duet.mid'],expectedStateVersion:4};
 return {service,args,context,writes};
}
const execute=(f,p)=>f.service.call('load_browser_item',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});

test('same-version native context replacement invalidates confirmation before loading',async()=>{
 const f=fixture(),plan=await f.service.call('load_browser_item',f.args);assert.deepEqual(f.writes,[]);f.context.identityToken='replacement';await assert.rejects(execute(f,plan),/plan|confirmation|context/i);assert.deepEqual(f.writes,[]);
});
test('a browser item change during planning refuses before issuing a load',async()=>{
 const f=fixture();f.context.item.uri='query:different';await assert.rejects(f.service.call('load_browser_item',f.args),/browser item changed/);assert.deepEqual(f.writes,[]);
});
test('partial native load errors retain track identities and the signed context',async()=>{
 const f=fixture(),plan=await f.service.call('load_browser_item',f.args),result=await execute(f,plan);assert.equal(result.observed.nativeLoadReturned,false);assert.equal(result.observed.loadError,'interrupted');assert.deepEqual(result.observed.trackEffect.addedTrackIds,['track-1']);assert.deepEqual(f.writes[0].beforeLoadContext,plan.plan.beforeLoadContext);
});
