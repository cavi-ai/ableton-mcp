import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

function fixture(){
 const before={stateVersion:4,setFingerprint:'set',identityToken:'native',root:'samples',path:['Kick.wav'],
  item:{name:'Kick.wav',uri:'sample',loadable:true,folder:false},previewSupported:true,stopSupported:true,previewStateObserved:false,
  transport:{isPlaying:true,arrangementRecord:false,sessionRecord:false,countingIn:false}};
 const calls=[],service=new ToolService({bridge:{async request(method,args){calls.push({method,args});
  if(method==='get_browser_preview_context')return {...structuredClone(before),...(args.root?{}:{root:null,path:null,item:null})};
  if(method==='set_browser_preview')return {commandRequested:true,nativeReturned:true,previewVerified:false};throw Error(method);}}});
 return {before,calls,service,args:{action:'start',root:'samples',path:['Kick.wav'],expectedStateVersion:4}};
}
test('preview planning is inert and unchanged confirmation calls native once',async()=>{
 const f=fixture(),p=await f.service.call('set_browser_preview',f.args);assert.equal(f.calls.length,1);
 assert.match(p.warning,/global|replace/i);const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 const r=await f.service.call('set_browser_preview',args);assert.equal(r.observed.nativeReturned,true);assert.equal(r.observed.previewVerified,false);
 await assert.rejects(f.service.call('set_browser_preview',args));assert.equal(f.calls.filter(x=>x.method==='set_browser_preview').length,1);
});
test('manual context or item changes reject an old confirmation before preview',async()=>{
 for(const change of [f=>f.before.identityToken='replaced',f=>f.before.item.uri='changed',f=>f.before.transport.isPlaying=false]){
  const f=fixture(),p=await f.service.call('set_browser_preview',f.args);change(f);
  await assert.rejects(f.service.call('set_browser_preview',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.calls.filter(x=>x.method==='set_browser_preview').length,0);
 }
});
test('unavailable preview or stop, folders, recording and unknown transport refuse',async()=>{
 for(const change of [f=>f.before.previewSupported=false,f=>f.before.stopSupported=false,f=>f.before.item.folder=true,
  f=>f.before.transport.arrangementRecord=true,f=>f.before.transport.countingIn=null]){
  const f=fixture();change(f);await assert.rejects(f.service.call('set_browser_preview',f.args));
  assert.equal(f.calls.filter(x=>x.method==='set_browser_preview').length,0);
 }
});
test('global stop has no item scope and is allowed during recording',async()=>{
 const f=fixture();f.before.transport.arrangementRecord=true;
 const args={action:'stop',expectedStateVersion:4},p=await f.service.call('set_browser_preview',args);
 assert.equal(p.plan.before.item,null);assert.match(p.warning,/global|user/i);
 await f.service.call('set_browser_preview',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
 assert.equal(f.calls.filter(x=>x.method==='set_browser_preview').length,1);
});
test('schemas reject incomplete, mixed or arbitrary preview arguments before native access',async()=>{
 const f=fixture(),route=createRouter(f.service);
 for(const args of [{...f.args,action:'load'},{...f.args,path:[]},{...f.args,trackId:'track-0'},
  {action:'stop',expectedStateVersion:4,root:'samples',path:['Kick.wav']},{action:'start',expectedStateVersion:4}]){
  const r=await route({id:1,method:'tools/call',params:{name:'set_browser_preview',arguments:args}});assert.equal(r.error?.code,-32602);
 }
 assert.equal(f.calls.length,0);
});
test('preview is all-profile and the workflow keeps sound selection separate from loading',async()=>{
 const f=fixture(),core=createRouter(f.service,{toolProfile:'core'});
 assert.equal((await core({id:1,method:'tools/call',params:{name:'get_browser_preview_context',arguments:{}}})).error.code,-32601);
 const text=getPrompt('audition-browser-sounds',{request:'Compare available kick samples'}).messages[0].content.text;
 for(const term of ['get_browser_preview_context','set_browser_preview','global','load_browser_item','audible','manual'])assert.ok(text.includes(term),term);
});
