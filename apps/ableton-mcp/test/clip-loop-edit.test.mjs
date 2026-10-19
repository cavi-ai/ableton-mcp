import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
function fixture(){
 const target={trackId:'track-0',clipId:'track-0:clip-0'},timing={stateVersion:4,...target,loop:{enabled:true,startBeats:0,endBeats:4}},context={stateVersion:4,...target,identityToken:'native',clipTiming:timing,material:{kind:'midi',notes:[]},editContext:Object.fromEntries(['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'].map(k=>[k,false]))};
 const calls=[],service=new ToolService({bridge:{async request(method,args){calls.push({method,args});
 if(method==='get_clip_timing')return structuredClone(timing);
 if(method==='get_clip_loop_edit_context')return structuredClone(context);
 if(method==='set_clip_timing')return {stateVersion:5,...target,loop:{enabled:true,startBeats:1,endBeats:4},requestedChangesVerified:false,error:'setter interrupted'};
 throw Error(method);
 }}});return {context,timing,calls,service,args:{...target,expectedStateVersion:4,loop:{startBeats:1}}};
}
test('loop plans bind native context and preserve partial receipts',async()=>{
 const f=fixture(),p=await f.service.call('set_clip_timing',f.args);
 assert.deepEqual(p.plan.loopEditContext,f.context);
 assert.deepEqual(f.calls.find(x=>x.method==='get_clip_loop_edit_context').args.changes,p.plan.changes);
 const r=await f.service.call('set_clip_timing',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
 assert.equal(r.observed.requestedChangesVerified,false);assert.match(r.observed.error,/interrupted/);
 assert.equal(r.operationOutcome.status,'outcome_unknown');
});

test('an empty optional loop does not demand loop evidence for a meter-only edit',async()=>{
 const target={trackId:'track-0',clipId:'track-0:clip-0'},calls=[];
 const timing={stateVersion:4,...target,loop:{enabled:true,unit:'beats',startBeats:0,endBeats:4},timeSignature:{numerator:4,denominator:4}};
 const service=new ToolService({bridge:{async request(method,args){
  calls.push(method);
  if(method==='get_clip_timing')return structuredClone(timing);
  assert.equal(method,'set_clip_timing');
  assert.deepEqual(args.changes,{timeSignature:{numerator:3,denominator:4}});
  return {...timing,stateVersion:5,timeSignature:{numerator:3,denominator:4}};
 }}});
 const args={...target,expectedStateVersion:4,loop:{},timeSignature:{numerator:3,denominator:4}};
 const plan=await service.call('set_clip_timing',args);
 assert.equal(plan.plan.loopEditContext,undefined);
 const result=await service.call('set_clip_timing',{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
 assert.equal(result.operationOutcome.status,'applied');
 assert.deepEqual(result.observed.timeSignature,{numerator:3,denominator:4});
 assert.equal(calls.includes('get_clip_loop_edit_context'),false);
});
test('same-version native replacement, notes and flags refuse confirmation',async()=>{
 for(const change of [c=>c.identityToken='replacement',c=>c.material.notes.push({noteId:7}),c=>c.editContext.arrangementRecord=true]){
 const f=fixture(),p=await f.service.call('set_clip_timing',f.args);change(f.context);
 await assert.rejects(f.service.call('set_clip_timing',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
 assert.equal(f.calls.some(x=>x.method==='set_clip_timing'),false);
 }
});
test('missing context, recording and unknown flags refuse planning',async()=>{
 for(const change of [c=>c.identityToken='',c=>c.editContext.clipRecording=true,c=>delete c.editContext.countingIn,c=>c.clipTiming={...c.clipTiming,loop:{enabled:true,startBeats:0,endBeats:8}}]){
 const f=fixture();change(f.context);await assert.rejects(f.service.call('set_clip_timing',f.args));
 assert.equal(f.calls.some(x=>x.method==='set_clip_timing'),false);
 }
});

test('phrase-loop workflow retrieval is read-only and validates modes',async()=>{
 const f=fixture();const r=await f.service.call('get_producer_workflow',{workflow:'set-clip-phrase-loop',arguments:{request:'Try this phrase once'}});assert.ok(r.messages.length);
 await assert.rejects(f.service.call('get_producer_workflow',{workflow:'set-clip-phrase-loop',arguments:{request:'Repeat this',mode:'replace'}}),/mode/);assert.equal(f.calls.length,0);
});

test('mode-change plans retain omitted observed bounds explicitly',async()=>{
 const f=fixture();const p=await f.service.call('set_clip_timing',{...f.args,loop:{enabled:false}});
 assert.deepEqual(p.plan.changes.loop,{enabled:false,startBeats:0,endBeats:4});
});

test('unwarped repetition refuses without silently enabling warping',async()=>{
 const f=fixture();f.timing.loop={enabled:false,unit:'seconds',startSeconds:0,endSeconds:4};
 await assert.rejects(f.service.call('set_clip_timing',{...f.args,loop:{enabled:true}}),/unwarped audio cannot loop/);
 assert.deepEqual(f.calls.map(x=>x.method),['get_clip_timing']);
});
