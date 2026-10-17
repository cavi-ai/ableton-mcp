import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

function fixture(){
 const target={trackId:'track-0',clipId:'track-0:clip-0'},note={noteId:7,pitch:60,start:0,duration:1,velocity:100,velocityDeviation:0,releaseVelocity:64,probability:1,mute:false};
 const selection={stateVersion:4,...target,status:'selected',selectionToken:'selection',noteIds:[7],notes:[note],editContext:{frozen:false,clipRecording:false,arrangementRecord:false,sessionRecord:false,countingIn:false}};
 const calls=[],service=new ToolService({bridge:{async request(method,args){calls.push({method,args});
  if(method==='get_midi_note_selection')return structuredClone(selection);
  if(method==='get_midi_clip_notes_extended')return {stateVersion:4,...target,lengthBeats:4,notes:[note]};
  if(method==='get_clip_timing')return {stateVersion:4,...target};
  if(method==='set_midi_note_properties')return {stateVersion:5,...target,notes:[{...note,velocity:70}]};throw Error(method);}}});
 return {selection,calls,service,args:{...target,expectedStateVersion:4,expectedNoteSelectionToken:'selection',changes:[{noteId:7,velocity:70}]}};
}
test('selected-note read forwards exact scope without editing',async()=>{
 const f=fixture(),r=await f.service.call('get_midi_note_selection',{trackId:'track-0',clipId:'track-0:clip-0'});
 assert.deepEqual(r,f.selection);assert.equal(f.calls.length,1);
});
test('selection-bound note edit retains token in confirmation and native request',async()=>{
 const f=fixture(),p=await f.service.call('set_midi_note_properties',f.args);assert.equal(p.plan.expectedNoteSelectionToken,'selection');
 await f.service.call('set_midi_note_properties',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
 assert.equal(f.calls.at(-1).method,'set_midi_note_properties');assert.equal(f.calls.at(-1).args.expectedNoteSelectionToken,'selection');
});
test('changed, empty, unobserved, recording or unrelated selection refuses before write',async()=>{
 for(const change of [f=>f.selection.selectionToken='changed',f=>f.selection.status='empty',f=>f.selection.status='unavailable',
  f=>f.selection.noteIds=[8],f=>f.selection.editContext.clipRecording=true,f=>f.selection.editContext={}]){
  const f=fixture(),p=await f.service.call('set_midi_note_properties',f.args);change(f);
  await assert.rejects(f.service.call('set_midi_note_properties',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.calls.filter(c=>c.method==='set_midi_note_properties').length,0);
 }
});
test('existing explicit-ID edit needs no selection observation',async()=>{
 const f=fixture(),{expectedNoteSelectionToken,...args}=f.args,p=await f.service.call('set_midi_note_properties',args);
 assert.equal('expectedNoteSelectionToken' in p.plan,false);assert.equal(f.calls.some(c=>c.method==='get_midi_note_selection'),false);
});
test('selection read is all-profile read-only and rejects non-read arguments',async()=>{
 const f=fixture(),route=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 const args={trackId:'track-0',clipId:'track-0:clip-0'};
 assert.equal((await core({id:1,method:'tools/call',params:{name:'get_midi_note_selection',arguments:args}})).error.code,-32601);
 assert.equal((await route({id:1,method:'tools/call',params:{name:'get_midi_note_selection',arguments:{...args,selectAll:true}}})).error.code,-32602);
});
