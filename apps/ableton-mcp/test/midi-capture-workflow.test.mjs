import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';

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

test('capture workflow distinguishes global hidden buffer scope and preserves manual edits',()=>{
  const text=getPrompt('keep-played-midi',{request:'Keep what I just played and leave it unquantized'}).messages[0].content.text;
  for(const term of ['get_midi_capture_context','capture_midi_session','get_midi_clip_notes_extended','captureVerified','allowExistingClipChanges'])assert.ok(text.includes(term),term);
  assert.match(text,/global/i);assert.match(text,/hidden/i);assert.match(text,/manual edits/i);assert.match(text,/never.*retry blindly/i);
});
