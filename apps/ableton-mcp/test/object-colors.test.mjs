import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';
import {getPrompt} from '../src/prompts.mjs';

const args={changes:[{objectId:'track-0',color:'#ff0000'},{objectId:'track-0:arrangement-clip-0',color:'#0000ff'}],expectedStateVersion:3,expectedSetFingerprint:'set'};
function fixture(){let identity='original',writes=0;const bridge={request:async(method,p)=>{
 if(method==='get_live_object_colors')return {stateVersion:3,setFingerprint:'set',identityToken:identity,selection:{},objects:p.objectIds.map(objectId=>({objectId,name:'part',supported:true,color:'#123456',colorIndex:7}))};
 assert.equal(method,'set_live_object_colors');writes++;return {stateVersion:4,writeCompleted:true,identityRetained:true,selectionUnchanged:true,objects:p.changes.map(({objectId,color})=>({objectId,requestedColor:color,color,colorIndex:2,supported:true,exactMatch:true,writeReturned:true}))};
}};return {service:new ToolService({bridge}),bridge,change(){identity='replacement';},get writes(){return writes;}};}

test('color plans are inert, normalize RGB and refuse replaced targets or reused confirmation',async()=>{
 const f=fixture(),p=await f.service.call('set_live_object_colors',args);assert.equal(f.writes,0);assert.equal(p.plan.changes[0].color,'#FF0000');const confirmed={...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};assert.equal((await f.service.call('set_live_object_colors',confirmed)).observed.writeCompleted,true);await assert.rejects(f.service.call('set_live_object_colors',confirmed));assert.equal(f.writes,1);
 const stale=fixture(),old=await stale.service.call('set_live_object_colors',args);stale.change();await assert.rejects(stale.service.call('set_live_object_colors',{...args,dryRun:false,confirmationToken:old.confirmation.token,planHash:old.confirmation.planHash}),/changed/);assert.equal(stale.writes,0);
});
test('color requests require explicit canonical unique targets, valid RGB and matching Set',async()=>{
 validateToolArguments('set_live_object_colors',args);
 for(const changes of [[],[...args.changes,args.changes[0]],[{objectId:'track-00',color:'#FF0000'}],[{objectId:'track-0',color:'red'}]])await assert.rejects(fixture().service.call('set_live_object_colors',{...args,changes}));
 await assert.rejects(fixture().service.call('set_live_object_colors',{...args,expectedSetFingerprint:'other'}),/Set/);
});
test('color tools are all-profile and distinguish native palette adjustment from exact RGB',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'}),listed=(await all({id:1,method:'tools/list'})).result.tools;
 assert.equal(listed.find(t=>t.name==='get_live_object_colors').annotations.readOnlyHint,true);assert.equal(listed.find(t=>t.name==='set_live_object_colors').annotations.destructiveHint,false);
 assert.equal((await core({id:2,method:'tools/call',params:{name:'set_live_object_colors',arguments:args}})).error.code,-32601);
 const original=f.bridge.request;f.bridge.request=async(...a)=>{const r=await original(...a);if(a[0]==='set_live_object_colors'){r.objects[0].color='#FE1234';r.objects[0].exactMatch=false;}return r;};
 const p=await f.service.call('set_live_object_colors',args),r=await f.service.call('set_live_object_colors',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});assert.equal(r.observed.writeCompleted,true);assert.equal(r.observed.objects[0].exactMatch,false);
});
test('incomplete or contradictory native receipts retain observations and require inspection',async()=>{
 for(const corrupt of [r=>delete r.identityRetained,r=>delete r.objects[0].supported,r=>r.objects[0].supported=null,r=>r.objects={},r=>r.objects.pop(),r=>r.objects[0].requestedColor='#00FF00',r=>r.objects[0].exactMatch=false,r=>r.stateVersion=3]){
  const f=fixture(),original=f.bridge.request;f.bridge.request=async(...a)=>{const r=await original(...a);if(a[0]==='set_live_object_colors')corrupt(r);return r;};
  const p=await f.service.call('set_live_object_colors',args),r=await f.service.call('set_live_object_colors',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});assert.equal(r.observed.writeCompleted,false);assert.equal(r.observed.inspectionRequired,true);assert.ok(r.observed.objects);
 }
});
test('organization workflow resolves explicit roles and preserves manually chosen content and focus',()=>{
 assert.throws(()=>getPrompt('organize-session'),/required/);
 const text=getPrompt('organize-session',{request:'Make the named bass track blue'}).messages[0].content.text;
 for(const required of ['Make the named bass track blue','get_live_object_colors','set_live_object_colors','exactMatch','manual','Arrangement','musical roles','rename_session_object'])assert.ok(text.includes(required),required);
});
test('an unassigned Scene palette entry can be planned without claiming it is already colored',async()=>{
 const f=fixture(),original=f.bridge.request;f.bridge.request=async(...a)=>{const r=await original(...a);if(a[0]==='get_live_object_colors')r.objects[0]={...r.objects[0],color:null,colorIndex:null};return r;};
 const p=await f.service.call('set_live_object_colors',{...args,changes:[{objectId:'scene-0',color:'#FF0000'}]});assert.equal(p.plan.before.objects[0].color,null);
});
