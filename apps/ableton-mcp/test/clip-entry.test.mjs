import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {withRequestSignal} from '../src/request-context.mjs';

function fixture(){
 const before={stateVersion:4,trackId:'track-0',clipId:'track-0:clip-0',identityToken:'native',unit:'beats',start:0,end:4,content:{notes:[{noteId:1,velocity:80}]}},calls=[];
 const service=new ToolService({bridge:{request:async(name,args)=>{calls.push({name,args});if(name==='get_session_clip_entry_context')return structuredClone(before);if(name==='set_session_clip_entry')return {verified:false,writeRequested:true,error:'readback differs',observed:{start:2}};throw Error(name);}}});
 return {before,service,calls,args:{trackId:before.trackId,clipId:before.clipId,expectedStateVersion:4,unit:'beats',start:2}};
}
test('entry planning is inert and one confirmation preserves partial native receipts',async()=>{
 const f=fixture(),plan=await f.service.call('set_session_clip_entry',f.args);assert.deepEqual(plan.plan.before,f.before);assert.equal(f.calls.length,1);
 const args={...f.args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 const result=await f.service.call('set_session_clip_entry',args);assert.equal(result.observed.verified,false);assert.equal(result.observed.observed.start,2);
 assert.match(result.timestamp,/^\d{4}-\d\d-\d\dT/);
 await assert.rejects(f.service.call('set_session_clip_entry',args));assert.equal(f.calls.filter(c=>c.name==='set_session_clip_entry').length,1);
});
test('entry confirmation refusals are tagged not executed, including cancellation',async()=>{
 const f=fixture(),p=await f.service.call('set_session_clip_entry',f.args),args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 const rejected=error=>error.outcome==='not_executed'&&error.code==='CONFIRMATION_REJECTED';
 await assert.rejects(f.service.call('set_session_clip_entry',{...args,planHash:'0'.repeat(64)}),error=>rejected(error)&&error.message==='Session entry confirmation context changed');
 await assert.rejects(f.service.call('set_session_clip_entry',{...args,confirmationToken:'unknown'}),error=>rejected(error)&&/unknown confirmation token/.test(error.message));
 const controller=new AbortController();controller.abort(Error('cancelled'));
 await assert.rejects(withRequestSignal(controller.signal,()=>f.service.call('set_session_clip_entry',args)),error=>rejected(error)&&error.message==='cancelled');
 assert.equal(f.calls.some(c=>c.name==='set_session_clip_entry'),false);
 assert.equal((await f.service.call('set_session_clip_entry',args)).dryRun,false);
});
test('entry plans reject replacement or same-version manual content and unit changes',async()=>{
 for(const change of [f=>f.before.identityToken='replacement',f=>f.before.content.notes[0].velocity=12,f=>f.before.unit='seconds']){
  const f=fixture(),p=await f.service.call('set_session_clip_entry',f.args);change(f);
  await assert.rejects(f.service.call('set_session_clip_entry',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));assert.equal(f.calls.some(c=>c.name==='set_session_clip_entry'),false);
 }
});
test('entry inputs require native units and a finite point before the retained end',async()=>{
 for(const patch of [{unit:'seconds'},{start:4},{start:NaN},{start:true},{expectedStateVersion:5}]){
  const f=fixture();await assert.rejects(f.service.call('set_session_clip_entry',{...f.args,...patch}));assert.equal(f.calls.some(c=>c.name==='set_session_clip_entry'),false);
 }
});
test('entry edits are outside core and reject Arrangement clips and missing arguments',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 assert.equal((await core({id:1,method:'tools/call',params:{name:'set_session_clip_entry',arguments:f.args}})).error.code,-32601);
 for(const patch of [{clipId:'track-0:arrangement-clip-0'},{unit:'samples'},{start:null}])assert.equal((await all({id:2,method:'tools/call',params:{name:'set_session_clip_entry',arguments:{...f.args,...patch}}})).error.code,-32602);
});
