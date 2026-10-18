import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

const note={pitch:67,start:1.5,duration:.25,velocity:83};
function fixture(){
 const target={trackId:'track-0',clipId:'track-0:clip-0'},before={stateVersion:4,setFingerprint:'set',identityToken:'native',...target,
  location:'session',timeline:null,notes:[{noteId:7,pitch:60,start:0,duration:1,velocity:100}],
  clipTiming:{loop:{enabled:true,startBeats:0,endBeats:4}},insertSupported:true,
  editContext:{frozen:false,clipRecording:false,clipOverdubbing:false,pendingLaunch:false,arrangementRecord:false,sessionRecord:false,countingIn:false}};
 let writes=0;
 const service=new ToolService({bridge:{async request(method){
  if(method==='get_midi_note_insertion_context')return structuredClone(before);
  if(method==='insert_midi_notes'){writes++;return {insertionVerified:false,nativeReturned:false,error:'partial insertion',addedNoteIds:[100]};}
  throw Error(method);
 }}});
 return {target,before,service,args:{...target,notes:[note],expectedStateVersion:4},writes:()=>writes};
}
test('insertion plan adds explicit defaults without replacing existing notes and confirms once',async()=>{
 const f=fixture(),p=await f.service.call('insert_midi_notes',f.args);
 assert.equal(f.writes(),0);assert.deepEqual(p.plan.notes,[{...note,velocityDeviation:0,releaseVelocity:64,probability:1,mute:false}]);
 assert.deepEqual(p.plan.before.notes,f.before.notes);
 const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 const result=await f.service.call('insert_midi_notes',args);assert.equal(f.writes(),1);
 assert.equal(result.observed.insertionVerified,false);assert.deepEqual(result.observed.addedNoteIds,[100]);
 await assert.rejects(f.service.call('insert_midi_notes',args));assert.equal(f.writes(),1);
});
test('same-version content timing or identity changes reject old confirmations',async()=>{
 for(const change of [f=>f.before.identityToken='new',f=>f.before.notes[0].velocity=42,f=>f.before.clipTiming.loop.endBeats=8]){
  const f=fixture(),p=await f.service.call('insert_midi_notes',f.args);change(f);
  await assert.rejects(f.service.call('insert_midi_notes',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));
  assert.equal(f.writes(),0);
 }
});
test('unsafe contexts and colliding same-pitch notes refuse without mutation',async()=>{
 const f=fixture();
 for(const key of Object.keys(f.before.editContext)){
  f.before.editContext[key]=null;await assert.rejects(f.service.call('insert_midi_notes',f.args));f.before.editContext[key]=false;
 }
 for(const notes of [[{...note,pitch:60,start:.5}],[note,{...note,start:1.6}],[]])
  await assert.rejects(f.service.call('insert_midi_notes',{...f.args,notes}));
 assert.equal(f.writes(),0);
});
test('schema rejects invalid and identity-bearing additions before native access',async()=>{
 const f=fixture(),route=createRouter(f.service);
 for(const notes of [[{...note,noteId:7}],[{...note,pitch:128}],[{...note,probability:2}],[{...note,velocity:1.5}],[],Array(4097).fill(note)]){
  const r=await route({id:1,method:'tools/call',params:{name:'insert_midi_notes',arguments:{...f.args,notes}}});assert.equal(r.error?.code,-32602);
 }
 const core=createRouter(f.service,{toolProfile:'core'});
 assert.equal((await core({id:1,method:'tools/call',params:{name:'get_midi_note_insertion_context',arguments:f.target}})).error.code,-32601);
 assert.equal(f.writes(),0);
});
