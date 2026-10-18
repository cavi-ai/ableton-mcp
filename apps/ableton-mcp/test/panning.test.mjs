import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

function fixture(){
 const parameter=value=>({supported:true,value,min:-1,max:1,enabled:true,quantized:false,automationState:{value:0,name:'none'}});
 const source={trackId:'track-0',stateVersion:4,identityToken:'mixer',frozen:false,mode:{supported:true,value:0,name:'stereo'},
  parameters:{pan:parameter(0),left:parameter(-1),right:parameter(1)},transport:{isPlaying:true,arrangementRecord:false,sessionRecord:false,countingIn:false}};
 const calls=[],service=new ToolService({bridge:{request:async(name,args)=>{calls.push({name,args});
  if(name==='get_mixer_panning_context')return structuredClone(source);
  if(name==='set_mixer_panning')return {stateVersion:5,verified:true};throw Error(name);}}});
 return {source,calls,service,args:{trackId:'track-0',pan:-.5,expectedStateVersion:4}};
}

test('mode-aware panning inspection and planning are inert; a single-use confirmation issues one edit',async()=>{
 const f=fixture();assert.equal((await f.service.call('get_mixer_panning_context',{trackId:'track-0'})).mode.name,'stereo');
 const p=await f.service.call('set_mixer_panning',f.args);assert.equal(p.dryRun,true);
 assert.equal(f.calls.filter(x=>x.name==='set_mixer_panning').length,0);
 const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 assert.equal((await f.service.call('set_mixer_panning',args)).observed.verified,true);
 await assert.rejects(()=>f.service.call('set_mixer_panning',args),/confirmation/);
 assert.equal(f.calls.filter(x=>x.name==='set_mixer_panning').length,1);
});

test('mode, values, automation and native identity edits invalidate a same-version pan plan',async()=>{
 for(const change of [f=>f.source.identityToken='new',f=>f.source.mode={supported:true,value:1,name:'splitStereo'},
   f=>f.source.parameters.pan.value=.25,f=>f.source.parameters.pan.automationState={value:1,name:'playing'},
   f=>f.source.parameters.left.value=-.25]){
  const f=fixture(),p=await f.service.call('set_mixer_panning',f.args);change(f);
  await assert.rejects(()=>f.service.call('set_mixer_panning',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.calls.filter(x=>x.name==='set_mixer_panning').length,0);
 }
});

test('wrong-mode values, combined setup, unknown targets and invalid values never reach mutation',async()=>{
 const f=fixture();
 for(const change of [{},{pan:NaN},{pan:true},{pan:2},{mode:'unknown'},{pan:0,left:0},{mode:'splitStereo',left:0}])
  await assert.rejects(()=>f.service.call('set_mixer_panning',{trackId:'track-0',expectedStateVersion:4,...change}));
 await assert.rejects(()=>f.service.call('set_mixer_panning',{trackId:'track-00',pan:0,expectedStateVersion:4}));
 await assert.rejects(()=>f.service.call('set_mixer_panning',{trackId:'track-0',left:0,expectedStateVersion:4}),/mode/);
 f.source.mode={supported:true,value:1,name:'splitStereo'};
 assert.equal((await f.service.call('set_mixer_panning',{trackId:'track-0',left:-.5,right:.5,expectedStateVersion:4})).dryRun,true);
 f.source.parameters.left.automationState={value:null,name:null};
 await assert.rejects(()=>f.service.call('set_mixer_panning',{trackId:'track-0',mode:'stereo',expectedStateVersion:4}),/automation/);
 assert.equal(f.calls.filter(x=>x.name==='set_mixer_panning').length,0);
});

test('pan tools are all-profile only and workflow distinguishes mode setup from channel placement',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 const tools=(await all({id:1,method:'tools/list'})).result.tools;
 assert.equal(tools.find(t=>t.name==='get_mixer_panning_context').annotations.readOnlyHint,true);
 assert.ok(tools.some(t=>t.name==='set_mixer_panning'));
 const mixed=await all({id:2,method:'tools/call',params:{name:'set_mixer_panning',arguments:{...f.args,mode:'splitStereo'}}});assert.equal(mixed.error.code,-32602);
 assert.equal((await core({id:3,method:'tools/call',params:{name:'get_mixer_panning_context',arguments:{trackId:'track-0'}}})).error.code,-32601);
 const text=getPrompt('shape-stereo-image',{request:'Narrow the selected pad.'}).messages[0].content.text;
 for(const term of ['get_mixer_panning_context','set_mixer_panning','input channel','separate','automation','partial','audible'])assert.ok(text.includes(term),term);
});

test('legacy single-pan planning requires observed Stereo mode for tracks, bulk, Return and Main',async()=>{
 for(const name of ['set_track_mixer','set_bulk_track_mixer','set_return_mixer','set_master_mixer']){
  const pan={value:0,min:-1,max:1,panningMode:{supported:true,value:1,name:'splitStereo'}},row={trackId:'track-0',stateVersion:4,pan,sends:[]};
  const service=new ToolService({bridge:{request:async()=>name==='set_master_mixer'?{stateVersion:4,master:row,returns:[{...row,id:'return-0'}]}:{stateVersion:4,identityToken:"mixer",trackIds:[name==='set_return_mixer'?'return-0':'track-0'],readyToChange:true,reasons:[],tracks:[{...row,trackId:name==='set_return_mixer'?'return-0':'track-0'}]}}});
  await assert.rejects(()=>service.call(name,{trackId:'track-0',trackIds:['track-0'],returnTrackId:'return-0',pan:.5,expectedStateVersion:4}),/Stereo/);
 }
});
