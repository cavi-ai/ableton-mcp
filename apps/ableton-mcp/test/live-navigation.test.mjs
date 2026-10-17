import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';

const args={trackId:'track-0',clipId:'track-0:clip-0',view:'Session',expectedStateVersion:3,expectedSetFingerprint:'set'};
function fixture(){let identity='first',writes=0;const service=new ToolService({bridge:{request:async(method,params)=>{
 if(method==='get_live_navigation_context')return {stateVersion:3,setFingerprint:'set',identityToken:identity,target:{kind:'clip',trackId:args.trackId,clipId:args.clipId,view:'Session'},selection:{},views:{Session:true},controls:{playing:false},deviceViews:[],groupsToReveal:[]};
 assert.equal(method,'show_live_object');writes++;return {stateVersion:4,target:params.before.target,showVerified:true,targetIdentityRetained:true,selectionVerified:true,viewsVerified:true,deviceViewsVerified:true,controlsUnchanged:true};
}}});return {service,get writes(){return writes;},change(){identity='replaced';}};}

test('navigation plans are inert, bind native context and consume confirmation once',async()=>{
 const f=fixture(),p=await f.service.call('show_live_object',args);assert.equal(f.writes,0);const confirmed={...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};assert.equal((await f.service.call('show_live_object',confirmed)).observed.showVerified,true);await assert.rejects(f.service.call('show_live_object',confirmed));assert.equal(f.writes,1);
 const stale=fixture(),old=await stale.service.call('show_live_object',args);stale.change();await assert.rejects(stale.service.call('show_live_object',{...args,dryRun:false,confirmationToken:old.confirmation.token,planHash:old.confirmation.planHash}),/changed|hash/);assert.equal(stale.writes,0);
});
test('navigation refuses conflicting selectors, wrong Set and incompatible views',async()=>{
 validateToolArguments('show_live_object',args);for(const a of [{...args,deviceId:'track-0:device-0'},{...args,view:'Arranger'},{...args,trackId:'track-00'},{...args,clipId:'track-0:clip-00'}])await assert.rejects(fixture().service.call('show_live_object',a));await assert.rejects(fixture().service.call('show_live_object',{...args,expectedSetFingerprint:'other'}),/Set/);
});
test('navigation is an explicit all-profile mutation and retains partial observations',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'}),listed=(await all({id:1,method:'tools/list'})).result.tools.find(t=>t.name==='show_live_object');assert.ok(listed);assert.equal(listed.annotations.readOnlyHint,false);assert.equal(listed.annotations.destructiveHint,false);assert.equal((await core({id:2,method:'tools/call',params:{name:'show_live_object',arguments:args}})).error.code,-32601);
 const service=new ToolService({bridge:{request:async(method,p)=>method==='get_live_navigation_context'?{stateVersion:3,setFingerprint:'set',identityToken:'id',target:{trackId:args.trackId,clipId:args.clipId,view:'Session'},selection:{},views:{},controls:{},deviceViews:[],groupsToReveal:[]}:{stateVersion:4,target:p.before.target,showVerified:false,inspectionRequired:true,error:'view unavailable',selection:{selectedTrack:{id:args.trackId}}}}});
 const p=await service.call('show_live_object',args),r=await service.call('show_live_object',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});assert.equal(r.observed.inspectionRequired,true);assert.equal(r.observed.error,'view unavailable');
});

test('an incomplete bridge verification claim stays unverified with its observations retained',async()=>{
 for(const key of ['deviceViewsVerified','target']){const f=fixture(),original=f.service.bridge.request;f.service.bridge.request=async(...a)=>{const r=await original(...a);if(a[0]==='show_live_object')delete r[key];return r;};
 const p=await f.service.call('show_live_object',args),r=await f.service.call('show_live_object',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});assert.equal(r.observed.showVerified,false);assert.equal(r.observed.bridgeReportedShowVerified,true);assert.equal(r.observed.inspectionRequired,true);assert.equal(r.observed.selectionVerified,true);assert.match(r.observed.verificationError,/Incomplete/);
 }
});
