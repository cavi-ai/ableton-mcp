import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {getProducerWorkflow} from '../src/prompts.mjs';

function fixture(){
  const timing={stateVersion:4,trackId:'track-0',clipId:'track-0:clip-0',mute:{supported:true,enabled:false}},
    context={stateVersion:4,trackId:'track-0',clipId:'track-0:clip-0',identityToken:'observed-native-clip',muted:false,controls:{playing:true}},calls=[];
  const service=new ToolService({bridge:{request:async(name,args)=>{
    calls.push({name,args});
    if(name==='get_clip_timing')return structuredClone(timing);
    if(name==='get_clip_mute_edit_context')return structuredClone(context);
    if(name==='set_clip_timing')return {...timing,mute:{supported:true,enabled:args.changes.mute}};
    throw Error(name);
  }}});
  return {service,timing,context,calls,args:{trackId:timing.trackId,clipId:timing.clipId,expectedStateVersion:4,mute:true}};
}

test('clip contribution workflow preserves material and distinguishes whole clips from sections',()=>{
  const text=getProducerWorkflow({workflow:'compare-clip-contribution',arguments:{request:'Try the bridge without the hats',mode:'autonomous'}}).messages[0].content.text;
  for(const term of ['get_clip_timing','set_clip_timing','muteEditContext','identityToken','whole clip','manual edits','audition-arrangement-passage'])assert.ok(text.includes(term),term);
  assert.match(text,/does not prove.*silence|does not prove.*heard/i);
  assert.throws(()=>getProducerWorkflow({workflow:'compare-clip-contribution',arguments:{request:'Try it',mode:'unknown'}}),/mode/);
});

test('clip mute binds native identity and sends one confirmed edit',async()=>{
  const f=fixture(),p=await f.service.call('set_clip_timing',f.args);
  assert.equal(p.plan.muteEditContext.identityToken,'observed-native-clip');
  assert.equal(f.calls.some(c=>c.name==='set_clip_timing'),false);
  const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
  const r=await f.service.call('set_clip_timing',args);assert.equal(r.observed.mute.enabled,true);
  await assert.rejects(f.service.call('set_clip_timing',args),/confirmation/);
  assert.equal(f.calls.filter(c=>c.name==='set_clip_timing').length,1);
});

test('equal-setting replacement or changed native mute context invalidates confirmation',async()=>{
  const f=fixture(),p=await f.service.call('set_clip_timing',f.args);f.context.identityToken='replacement';
  await assert.rejects(f.service.call('set_clip_timing',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}),/hash|changed|plan/);
  f.context.muted=true;
  await assert.rejects(f.service.call('set_clip_timing',f.args),/context|native/);
  assert.equal(f.calls.some(c=>c.name==='set_clip_timing'),false);
});

test('unsupported or mismatched native owners refuse before mutation',async()=>{
  for(const patch of [{identityToken:null},{trackId:'track-9'},{stateVersion:5}]){
    const f=fixture();Object.assign(f.context,patch);
    await assert.rejects(f.service.call('set_clip_timing',f.args),/context|native|state|version|mismatch/i);
    assert.equal(f.calls.some(c=>c.name==='set_clip_timing'),false);
  }
});
