import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';

function fixture() {
  const target={trackId:'track-0',clipId:'track-0:clip-0'};
  const note=(noteId,start,duration,pitch=60)=>({noteId,start,duration,pitch,velocity:91,
    releaseVelocity:62,velocityDeviation:-3,probability:.75,mute:false});
  const before={stateVersion:4,setFingerprint:'set',identityToken:'clip',...target,location:'session',timeline:null,
    notes:[note(7,2,.5),note(8,3,.25,64),note(9,5,.5,67)],
    clipTiming:{stateVersion:4,...target,markers:{unit:'beats',startBeats:0,endBeats:8},
      loop:{enabled:true,unit:'beats',startBeats:2,endBeats:8}},
    editContext:{frozen:false,clipRecording:false,clipOverdubbing:false,pendingLaunch:false,
      arrangementRecord:false,sessionRecord:false,countingIn:false}};
  let writes=0,readError=false,ignore=false;
  const service=new ToolService({bridge:{async request(method,args){
    if(method==='get_midi_note_removal_context'){
      if(writes&&readError)throw Error('read unavailable');
      return structuredClone(before);
    }
    if(method==='get_midi_clip_notes_extended')return {...structuredClone(before),lengthBeats:6};
    if(method==='get_clip_timing')return structuredClone(before.clipTiming);
    if(method==='transform_midi_notes'){
      writes++;before.stateVersion++;before.clipTiming.stateVersion++;
      if(!ignore)before.notes=before.notes.map(n=>{const c=args.changes.find(c=>c.noteId===n.noteId);
        return c?{...n,start:c.start,duration:c.duration}:n;});
      return {stateVersion:5,...target,nativeReturned:true,timeScalingVerified:!ignore,error:null};
    }
    throw Error(method);
  }}});
  const args={...target,expectedStateVersion:4,noteIds:[8,7],operation:{type:'scaleTime',factor:2,originBeats:2}};
  return {before,service,args,writes:()=>writes,setReadError:()=>readError=true,setIgnore:()=>ignore=true};
}
async function apply(f,p){return f.service.call('transform_midi_notes',{...f.args,dryRun:false,
  confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});}

test('scales only exact notes around an explicit nonzero clip origin',async()=>{
  const f=fixture(),p=await f.service.call('transform_midi_notes',f.args);
  assert.equal(f.writes(),0);
  assert.deepEqual(p.plan.changes.map(({noteId,start,duration})=>({noteId,start,duration})),
    [{noteId:7,start:2,duration:1},{noteId:8,start:4,duration:.5}]);
  const result=await apply(f,p);assert.equal(f.writes(),1);
  assert.equal(result.verification.confirmed,true);
  assert.equal(result.readback.notes[2].start,5);
  assert.equal(result.readback.notes[0].probability,.75);
});
test('compresses note starts and durations without changing bounds',async()=>{
  const f=fixture();f.args.operation.factor=.5;
  const p=await f.service.call('transform_midi_notes',f.args);
  assert.deepEqual(p.plan.changes.map(c=>[c.start,c.duration]),[[2,.25],[2.5,.125]]);
  assert.deepEqual(p.plan.before.clipTiming,f.before.clipTiming);
});
test('nonlooped markers define absolute bounds rather than native clip length',async()=>{
  const f=fixture();f.before.clipTiming.loop.enabled=false;
  f.before.clipTiming.markers.startBeats=2;f.before.clipTiming.markers.endBeats=5;
  const p=await f.service.call('transform_midi_notes',f.args);
  assert.equal(p.plan.changes[1].start,4);
});
test('invalid factors origins IDs overflow and retained-note collisions refuse',async()=>{
  for(const change of [f=>f.args.operation.factor=1,f=>f.args.operation.factor=0,
    f=>f.args.operation.factor=5,f=>delete f.args.operation.originBeats,
    f=>f.args.operation.originBeats=-1,f=>f.args.noteIds=[7,7],f=>f.args.noteIds=[99],
    f=>{f.args.noteIds=[9];f.args.operation.factor=4;},
    f=>{f.before.notes[2].start=4;f.before.notes[2].pitch=64;}]){
    const f=fixture();change(f);await assert.rejects(f.service.call('transform_midi_notes',f.args));
    assert.equal(f.writes(),0);
  }
});
test('same-version manual edits identity changes and recording refuse signed plans',async()=>{
  for(const change of [f=>f.before.notes[0].velocity=42,f=>f.before.identityToken='replacement',
    f=>f.before.clipTiming.loop.endBeats=7,f=>f.before.editContext.countingIn=true]){
    const f=fixture(),p=await f.service.call('transform_midi_notes',f.args);change(f);
    await assert.rejects(apply(f,p));assert.equal(f.writes(),0);
  }
});
test('unavailable readback and ignored writes retain the result without confirmation',async()=>{
  for(const mode of ['read','ignore']){
    const f=fixture(),p=await f.service.call('transform_midi_notes',f.args);
    if(mode==='read')f.setReadError();else f.setIgnore();
    const result=await apply(f,p);assert.equal(f.writes(),1);
    assert.equal(result.verification.confirmed,false);
    if(mode==='read')assert.match(result.verification.error,/unavailable/);
  }
});
test('scaleTime is a strict operation in the existing transform contract',()=>{
  const f=fixture();assert.equal(validateToolArguments('transform_midi_notes',f.args).operation.factor,2);
});
