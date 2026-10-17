import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

function fixture(){
 const source={stateVersion:4,identityToken:'native-tracks',trackIds:['track-0'],controls:{isPlaying:true},tracks:[{id:'track-0',arrangementOverride:true}]};
 const calls=[],service=new ToolService({bridge:{request:async(name,args)=>{
  calls.push({name,args});
  if(name==='get_arrangement_return_source')return structuredClone(source);
  if(name==='return_tracks_to_arrangement')return {stateVersion:5,returned:true,playheadWriteRequested:false};
  throw Error(name);
 }}});
 return {service,source,calls,args:{trackIds:['track-0'],expectedStateVersion:4}};
}

test('return planning is inert and an unchanged plan executes once',async()=>{
 const f=fixture(),p=await f.service.call('return_tracks_to_arrangement',f.args);
 assert.equal(p.dryRun,true);assert.equal(f.calls.length,1);assert.match(p.warning,/Session|phase/);
 const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 assert.equal((await f.service.call('return_tracks_to_arrangement',args)).observed.returned,true);
 await assert.rejects(()=>f.service.call('return_tracks_to_arrangement',args),/confirmation/);
 assert.equal(f.calls.filter(x=>x.name==='return_tracks_to_arrangement').length,1);
});

test('native replacement and manual control changes invalidate return confirmation',async()=>{
 for(const change of [f=>f.source.identityToken='replacement',f=>f.source.controls.isPlaying=false,f=>f.source.stateVersion++]){
  const f=fixture(),p=await f.service.call('return_tracks_to_arrangement',f.args);change(f);
  await assert.rejects(()=>f.service.call('return_tracks_to_arrangement',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}),/changed|hash|stale/);
  assert.equal(f.calls.filter(x=>x.name==='return_tracks_to_arrangement').length,0);
 }
});

test('return validates bounded exact scopes and remains outside core',async()=>{
 const f=fixture();
 for(const trackIds of [[],['master'],['track-0','track-0'],['track--1'],Array.from({length:65},(_,i)=>'track-'+i)])
  await assert.rejects(()=>f.service.call('return_tracks_to_arrangement',{...f.args,trackIds}),/track/);
 assert.equal(f.calls.length,0);
 const all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 assert.ok((await all({id:1,method:'tools/list'})).result.tools.some(t=>t.name==='return_tracks_to_arrangement'));
 assert.equal((await core({id:2,method:'tools/call',params:{name:'return_tracks_to_arrangement',arguments:f.args}})).error.code,-32601);
});

test('return workflow preserves transport and distinguishes partial native results',()=>{
 const text=getPrompt('resume-arrangement-tracks',{request:'Return the bass to Arrangement.'}).messages[0].content.text;
 for(const term of ['return_tracks_to_arrangement','get_scene_launch_context','finish_session_clip_hold','partial','playhead','Group'])assert.ok(text.includes(term),term);
 assert.match(text,/recording/);assert.match(text,/replay|repeat/);assert.match(text,/audible|hears/);
});
