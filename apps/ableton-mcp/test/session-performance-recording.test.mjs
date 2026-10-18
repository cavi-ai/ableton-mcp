import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getProducerWorkflow} from '../src/prompts.mjs';

function fixture(){
  const source={stateVersion:3,identityToken:'native-tail',startBeats:64,endBeats:96,controls:{arms:[false]},arrangement:[]};
  const recording={stateVersion:4,recordingId:'retained',status:'recording',controlContext:{recording:true,playing:true,status:'recording'},capturedClips:[]};
  const calls=[];
  const service=new ToolService({bridge:{request:async(name,args)=>{
    calls.push({name,args});
    if(name==='get_session_arrangement_source')return structuredClone(source);
    if(name==='record_session_arrangement')return structuredClone(recording);
    if(name==='get_session_arrangement_recording')return args.recordingId?structuredClone(recording):{stateVersion:4,recordings:[structuredClone(recording)]};
    if(name==='finish_session_arrangement_recording')return {...recording,status:'cancelled',released:true};
    throw Error(name);
  }}});
  return {service,source,recording,calls,args:{startBeats:64,endBeats:96,expectedStateVersion:3}};
}

test('Session performance start previews exact empty-tail context and consumes one confirmed request',async()=>{
  const f=fixture(),p=await f.service.call('record_session_arrangement',f.args);
  assert.equal(f.calls.length,1);assert.match(p.warning,/global/);assert.match(p.warning,/display tick|display-tick/);
  const input={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
  const result=await f.service.call('record_session_arrangement',input);
  assert.equal(result.observed.recordingId,'retained');assert.equal(f.calls.filter(x=>x.name==='record_session_arrangement').length,1);
  await assert.rejects(f.service.call('record_session_arrangement',input),/confirmation/);
});

test('changed source or invalid range refuses without native start',async()=>{
  const f=fixture(),p=await f.service.call('record_session_arrangement',f.args);f.source.identityToken='replacement';
  await assert.rejects(f.service.call('record_session_arrangement',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}),/changed|hash/);
  for(const input of [{startBeats:-1},{endBeats:64},{endBeats:600},{endBeats:NaN}])await assert.rejects(f.service.call('record_session_arrangement',{...f.args,...input}),/range|beats/);
  assert.equal(f.calls.filter(x=>x.name==='record_session_arrangement').length,0);
});

test('reconnect lists recordings and stop confirmation excludes advancing clip ends',async()=>{
  const f=fixture();assert.equal((await f.service.call('get_session_arrangement_recording',{})).recordings[0].recordingId,'retained');
  const args={recordingId:'retained',cancel:true,expectedStateVersion:4},p=await f.service.call('finish_session_arrangement_recording',args);
  f.recording.capturedClips=[{endBeats:79}];
  const result=await f.service.call('finish_session_arrangement_recording',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
  assert.equal(result.observed.released,true);
  const fresh=await f.service.call('finish_session_arrangement_recording',args);f.recording.controlContext.recording=false;
  await assert.rejects(f.service.call('finish_session_arrangement_recording',{...args,dryRun:false,confirmationToken:fresh.confirmation.token,planHash:fresh.confirmation.planHash}),/changed|hash/);
});

test('Session capture tools are all-profile and validate cancellation before writes',async()=>{
  const f=fixture(),router=createRouter(f.service),all=(await router({id:1,method:'tools/list'})).result.tools;
  assert.equal(all.find(t=>t.name==='get_session_arrangement_recording').annotations.readOnlyHint,true);
  const core=createRouter(f.service,{toolProfile:'core'});
  assert.ok(!(await core({id:2,method:'tools/list'})).result.tools.some(t=>t.name==='record_session_arrangement'));
  const response=await router({id:3,method:'tools/call',params:{name:'finish_session_arrangement_recording',arguments:{recordingId:'retained',cancel:'true',expectedStateVersion:4}}});
  assert.equal(response.error.code,-32602);
});

test('performance workflow distinguishes captured Session choices from input recording and exact timing',()=>{
  const result=getProducerWorkflow({workflow:'record-session-arrangement',arguments:{request:'Perform the intro and chorus scenes into a new Arrangement passage',mode:'autonomous'}});
  const text=result.messages[0].content.text;
  for(const term of ['record_session_arrangement','get_session_arrangement_recording','finish_session_arrangement_recording','append','manual edits','recordingId','return_tracks_to_arrangement','automation'])assert.ok(text.includes(term),term);
  assert.match(text,/never replay/i);assert.match(text,/not.*sample|not.*exact/i);
  assert.throws(()=>getProducerWorkflow({workflow:'record-session-arrangement',arguments:{request:'Jam',mode:'unknown'}}),/mode/);
});
