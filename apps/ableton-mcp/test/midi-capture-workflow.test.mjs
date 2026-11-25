import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

test('MIDI capture binds the native global context and requires explicit existing-clip scope',async()=>{
  const before={stateVersion:3,available:true,possibleTrackIds:['track-0'],overdubClipIds:['track-0:clip-0'],identityToken:'native'};
  const service=new ToolService({bridge:{async request(method,args){
    if(method==='get_midi_capture_context')return structuredClone(before);
    assert.equal(method,'capture_midi_session');assert.deepEqual(args.before,before);
    return {captureRequested:true,captureVerified:false};
  }}});
  await assert.rejects(()=>service.call('capture_midi_session',{expectedStateVersion:3}),/playing/);
  const args={expectedStateVersion:3,allowExistingClipChanges:true};
  const plan=await service.call('capture_midi_session',args);
  assert.equal(plan.plan.allowExistingClipChanges,true);
  assert.match(plan.plan.warning,/rebuild playing clips/);
  assert.match(plan.plan.warning,/outside the resulting loop/);
  const result=await service.call('capture_midi_session',{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  assert.equal(result.observed.captureVerified,false);
});
