import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {toolContracts} from '../src/tool-contracts.mjs';

function fixture(){
 const target={trackId:'track-0',clipId:'track-0:clip-0'},before={stateVersion:4,setFingerprint:'set',identityToken:'native',...target,
  location:'session',timeline:null,notes:[{noteId:7,pitch:60,start:0,duration:1,velocity:100},{noteId:8,pitch:64,start:0,duration:1,velocity:90}],
  clipTiming:{loop:{enabled:true,startBeats:0,endBeats:4}},removeSupported:true,
  editContext:{frozen:false,clipRecording:false,clipOverdubbing:false,pendingLaunch:false,arrangementRecord:false,sessionRecord:false,countingIn:false}};
 let writes=0;
 const service=new ToolService({bridge:{async request(method){
  if(method==='get_midi_note_removal_context')return structuredClone(before);
  if(method==='remove_midi_notes'){writes++;return {removalVerified:false,nativeReturned:false,error:'partial removal',removedNoteIds:[7],remainingRequestedNoteIds:[8]};}
  throw Error(method);
 }}});
 return {target,before,service,args:{...target,noteIds:[8,7],expectedStateVersion:4},writes:()=>writes};
}
test('plan lists exact removed note properties, canonicalizes IDs and confirms once',async()=>{
 const f=fixture(),p=await f.service.call('remove_midi_notes',f.args);
 assert.equal(f.writes(),0);assert.deepEqual(p.plan.noteIds,[7,8]);assert.deepEqual(p.removedNotes,f.before.notes);
 assert.match(p.warning,/expression|destruct/i);
 const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 const result=await f.service.call('remove_midi_notes',args);assert.equal(f.writes(),1);
 assert.equal(result.observed.removalVerified,false);assert.deepEqual(result.observed.remainingRequestedNoteIds,[8]);
 await assert.rejects(f.service.call('remove_midi_notes',args));assert.equal(f.writes(),1);
});
test('same-version identity content and timing changes reject old deletion plans',async()=>{
 for(const change of [f=>f.before.identityToken='new',f=>f.before.notes[0].velocity=42,f=>f.before.clipTiming.loop.endBeats=8]){
  const f=fixture(),p=await f.service.call('remove_midi_notes',f.args);change(f);
  await assert.rejects(f.service.call('remove_midi_notes',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.writes(),0);
 }
});
test('unsafe sources and unknown duplicate or invalid IDs refuse before removal',async()=>{
 const f=fixture();
 for(const key of Object.keys(f.before.editContext)){
  f.before.editContext[key]=null;await assert.rejects(f.service.call('remove_midi_notes',f.args));f.before.editContext[key]=false;
 }
 for(const noteIds of [[],[7,7],[100],[true],[-1],[7.5]])await assert.rejects(f.service.call('remove_midi_notes',{...f.args,noteIds}));
 assert.equal(f.writes(),0);
});
test('deletion is destructive, read is inert and schema/profile boundaries reject invalid access',async()=>{
 const f=fixture(),route=createRouter(f.service);
 assert.equal(toolContracts.remove_midi_notes.annotations.destructiveHint,true);
 assert.equal(toolContracts.get_midi_note_removal_context.annotations.readOnlyHint,true);
 for(const noteIds of [[],[7,7],[true],[-1],[1.5],Array.from({length:4097},(_,i)=>i)]){
  const r=await route({id:1,method:'tools/call',params:{name:'remove_midi_notes',arguments:{...f.args,noteIds}}});assert.equal(r.error?.code,-32602);
 }
 const core=createRouter(f.service,{toolProfile:'core'});
 assert.equal((await core({id:1,method:'tools/call',params:{name:'get_midi_note_removal_context',arguments:f.target}})).error.code,-32601);
 assert.equal(f.writes(),0);
});
