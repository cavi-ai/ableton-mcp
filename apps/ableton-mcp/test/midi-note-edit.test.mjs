import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

function fixture(){
 const target={trackId:'track-0',clipId:'track-0:clip-0'},note={noteId:7,pitch:60,start:0,duration:1,velocity:100,velocityDeviation:0,releaseVelocity:64,probability:1,mute:false};
 const before={stateVersion:4,...target,location:'session',timeline:null,lengthBeats:4,notes:[note]},timing={stateVersion:4,...target};
 const context={...before,identityToken:'native',modifySupported:true,clipTiming:timing,editContext:Object.fromEntries(['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'].map(k=>[k,false]))};
 const calls=[],service=new ToolService({bridge:{async request(method,args){calls.push({method,args});
  if(method==='get_midi_clip_notes_extended')return structuredClone(before);
  if(method==='get_clip_timing')return structuredClone(timing);
  if(method==='get_midi_note_edit_context')return structuredClone(context);
  if(method==='set_midi_note_properties')return {stateVersion:5,...target,writeRequested:true,nativeReturned:false,editVerified:false,error:'native interrupted',notes:[{...note,velocity:70}]};
  throw Error(method);
 }}});
 return {context,calls,service,args:{...target,expectedStateVersion:4,changes:[{noteId:7,velocity:70}]}};
}

test('direct property edits bind native context and return partial native state',async()=>{
 const f=fixture(),dry=await f.service.call('set_midi_note_properties',f.args);
 assert.deepEqual(dry.plan.propertyEditContext,f.context);
 assert.equal(f.calls.some(c=>c.method==='set_midi_note_properties'),false);
 const result=await f.service.call('set_midi_note_properties',{...f.args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash});
 assert.equal(result.observed.editVerified,false);assert.match(result.observed.error,/interrupted/);
 assert.equal(f.calls.filter(c=>c.method==='set_midi_note_properties').length,1);
});

test('same-version native replacement, edits and recording refuse confirmation',async()=>{
 for(const change of [c=>c.identityToken='replaced',c=>c.notes[0].velocity=31,c=>c.clipTiming={...c.clipTiming,loop:{}},c=>c.editContext.pendingLaunch=true]){
  const f=fixture(),dry=await f.service.call('set_midi_note_properties',f.args);change(f.context);
  await assert.rejects(f.service.call('set_midi_note_properties',{...f.args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash}));
  assert.equal(f.calls.some(c=>c.method==='set_midi_note_properties'),false);
 }
});

test('unknown edit flags and unsupported native modifications fail closed',async()=>{
 for(const change of [c=>delete c.editContext.clipOverdubbing,c=>c.modifySupported=false,c=>c.identityToken='',c=>c.editContext.frozen=null]){
  const f=fixture();change(f.context);await assert.rejects(f.service.call('set_midi_note_properties',f.args));
  assert.equal(f.calls.some(c=>c.method==='set_midi_note_properties'),false);
 }
});

test('duplicate requested IDs refuse instead of issuing an ambiguous plan',async()=>{
 const f=fixture();await assert.rejects(f.service.call('set_midi_note_properties',{...f.args,changes:[...f.args.changes,...f.args.changes]}),/duplicate/);
});
