import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

test('scene capture plans bind the native combination and confirm once without replay',async()=>{
  let token='native-1',writes=0;
  const service=new ToolService({bridge:{request:async(method,args)=>{
    if(method==='get_session_scene_capture_context')return {stateVersion:4,identityToken:token,afterSceneId:'scene-0',tracks:[{playingClipId:'track-0:clip-2'}]};
    assert.equal(method,'capture_session_scene');writes++;return {stateVersion:5,captureRequested:true,captureVerified:false,error:'retained partial scene'};
  }}});
  const args={afterSceneId:'scene-0',name:'Jam',expectedStateVersion:4},plan=await service.call('capture_session_scene',args);assert.equal(writes,0);assert.equal(plan.plan.launchesCapturedScene,true);
  const input={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};token='replacement';await assert.rejects(service.call('capture_session_scene',input));token='native-1';
  const result=await service.call('capture_session_scene',input);assert.equal(result.observed.captureVerified,false);
  assert.equal(result.operationOutcome?.status,'outcome_unknown');
  assert.equal(writes,1);await assert.rejects(service.call('capture_session_scene',input));
});

test('scene capture requires explicit selected anchor and name and stays outside core',async()=>{
  const service=new ToolService({bridge:{request:async()=>{throw Error('invalid requests must not reach Live');}}}),route=createRouter(service),core=createRouter(service,{toolProfile:'core'});
  const tool=(await route({id:0,method:'tools/list'})).result.tools.find(tool=>tool.name==='capture_session_scene');
  assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.destructiveHint,true);
  for(const args of [{name:'Jam',expectedStateVersion:4},{afterSceneId:'scene-0',name:'bad\nname',expectedStateVersion:4},{afterSceneId:'scene-0',name:'Jam'}])assert.equal((await route({id:1,method:'tools/call',params:{name:'capture_session_scene',arguments:args}})).error.code,-32602);
  assert.equal((await core({id:2,method:'tools/call',params:{name:'capture_session_scene',arguments:{afterSceneId:'scene-0',name:'Jam',expectedStateVersion:4}}})).error.code,-32601);
});

test('keeping a jam distinguishes a clip combination from audio, mixer and playback phase',()=>{
  const text=getPrompt('keep-session-combination',{request:'Keep this current jam as a named verse scene'}).messages[0].content.text;
  for(const word of ['capture_session_scene','afterSceneId','get_scene_launch_context','mixer','phase','partial','recording'])assert.ok(text.toLowerCase().includes(word.toLowerCase()));
  assert.match(text,/does not.*record.*audio/i);assert.match(text,/never.*replay/i);assert.match(text,/launches the new row immediately/);assert.match(text,/All explicit and implicit track arms must be off/);
});
