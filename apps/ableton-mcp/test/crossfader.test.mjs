import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

function fixture(){
 const position={supported:true,value:0,min:-1,max:1,enabled:true,quantized:false,automationState:{value:0,name:'none'}};
 const source={stateVersion:4,identityToken:'bus',position,transport:{isPlaying:true,arrangementRecord:false,sessionRecord:false,countingIn:false},tracks:[{trackId:'track-0',assignment:{supported:true,value:1,name:'none'}}]};
 const calls=[],service=new ToolService({bridge:{request:async(name,args)=>{calls.push({name,args});
  if(name==='get_crossfader_context')return structuredClone(source);
  if(name==='set_crossfader_state')return {stateVersion:5,verified:true};throw Error(name);}}});
 return {source,calls,service,args:{assignments:[{trackId:'track-0',side:'A'}],expectedStateVersion:4}};
}

test('crossfader read and planning are inert; unchanged confirmation executes once',async()=>{
 const f=fixture();assert.equal((await f.service.call('get_crossfader_context',{})).position.value,0);
 const p=await f.service.call('set_crossfader_state',f.args);assert.equal(p.dryRun,true);assert.match(p.warning,/entire|all|every/);
 const input={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 assert.equal((await f.service.call('set_crossfader_state',input)).observed.verified,true);
 await assert.rejects(()=>f.service.call('set_crossfader_state',input),/confirmation/);
 assert.equal(f.calls.filter(x=>x.name==='set_crossfader_state').length,1);
});

test('changed native identity, bus membership, automation and Main value invalidate position moves',async()=>{
 for(const change of [f=>f.source.identityToken='new',f=>f.source.tracks[0].assignment.value=2,
                       f=>f.source.position.automationState={value:1,name:'playing'},f=>f.source.position.value=.5]){
  const f=fixture(),args={position:-.5,expectedStateVersion:4},p=await f.service.call('set_crossfader_state',args);change(f);
  await assert.rejects(()=>f.service.call('set_crossfader_state',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.calls.filter(x=>x.name==='set_crossfader_state').length,0);
 }
});

test('invalid and combined requests stop before native reads; tools remain all-only',async()=>{
 const f=fixture();
 for(const args of [{},{position:true},{position:2},{position:NaN},{assignments:[]}, {...f.args,position:0},
                   {assignments:[{trackId:'master',side:'A'}]}, {assignments:[{trackId:'track-0',side:'C'}]},
                   {assignments:[...f.args.assignments,...f.args.assignments]}])
  await assert.rejects(()=>f.service.call('set_crossfader_state',{...args,expectedStateVersion:4}));
 assert.equal(f.calls.length,0);
 const all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 const tools=(await all({id:1,method:'tools/list'})).result.tools;
 assert.equal(tools.find(t=>t.name==='get_crossfader_context').annotations.readOnlyHint,true);
 assert.ok(tools.some(t=>t.name==='set_crossfader_state'));
 assert.equal((await core({id:2,method:'tools/call',params:{name:'get_crossfader_context',arguments:{}}})).error.code,-32601);
});

test('crossfader workflow exposes all members, separates setup and movement, and preserves partial work',()=>{
 const text=getPrompt('crossfade-parts',{request:'Prepare bass and pads on A/B.'}).messages[0].content.text;
 for(const term of ['get_crossfader_context','set_crossfader_state','Return','Group','automation','partial','separate','audible'])assert.ok(text.includes(term),term);
});
