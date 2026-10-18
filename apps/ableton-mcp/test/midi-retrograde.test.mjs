import test from 'node:test';
import assert from 'node:assert/strict';
import {planMidiRetrograde} from '../src/midi-retrograde.mjs';
import {ToolService} from '../src/tool-service.mjs';
import {getPrompt} from '../src/prompts.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';
const note=(noteId,pitch,start,duration)=>({noteId,pitch,start,duration,velocity:88,velocityDeviation:-3,releaseVelocity:71,probability:.8,mute:false});
const notes=[note(1,60,2,.5),note(2,64,3,1),note(3,67,5,.5),note(4,72,7,1)];
const operation={type:'reverseTime',startBeats:2,endBeats:6};

test('retrograde reflects whole note spans in an offset window and preserves metadata',()=>{
 const changes=planMidiRetrograde(notes,[3,1,2],operation);assert.deepEqual(changes.map(x=>[x.noteId,x.start]),[[1,5.5],[2,4],[3,2.5]]);
 const after=notes.map(n=>({...n,...(changes.find(c=>c.noteId===n.noteId)?{start:changes.find(c=>c.noteId===n.noteId).start}:{})}));
 const reversed=planMidiRetrograde(after,[1,2,3],operation);assert.deepEqual(reversed.map(c=>[c.noteId,c.start]),[[1,2],[2,3],[3,5]]);
 for(const change of changes)assert.deepEqual(change.previous,notes.find(n=>n.noteId===change.noteId));
});

test('invalid windows, partial spans, invalid IDs and new retained-note overlaps refuse',()=>{
 for(const op of [{...operation,endBeats:2},{...operation,endBeats:Infinity},{...operation,startBeats:-1},{...operation,endBeats:1027},{...operation,extra:1}])assert.throws(()=>planMidiRetrograde(notes,[1],op));
 for(const ids of [[],[1,1],[99],[4],[true]])assert.throws(()=>planMidiRetrograde(notes,ids,operation));
 assert.throws(()=>planMidiRetrograde([...notes,note(5,60,5.5,.5)],[1],operation),/overlap/);
 assert.deepEqual(planMidiRetrograde([note(1,60,3.5,1)],[1],{type:'reverseTime',startBeats:2,endBeats:6}),[]);
 assert.throws(()=>planMidiRetrograde([{...notes[0],start:NaN}],[1],operation));
});

test('native identity changes refuse while partial receipts are retained and consumed once',async()=>{
 let identity='original',writes=0;
 const context=()=>({stateVersion:4,trackId:'track-0',clipId:'track-0:clip-0',identityToken:identity,modifySupported:true,notes,clipTiming:{stateVersion:4},editContext:Object.fromEntries(['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'].map(k=>[k,false]))});
 const service=new ToolService({bridge:{request:async(method)=>{
  if(method==='get_midi_retrograde_context')return context();
  assert.equal(method,'transform_midi_notes');writes++;return {reversalVerified:false,nativeReturned:false,observed:{notes},error:'partial'};
 }}});
 const args={trackId:'track-0',clipId:'track-0:clip-0',expectedStateVersion:4,noteIds:[1,2,3],operation};
 const dry=await service.call('transform_midi_notes',args);assert.equal(writes,0);assert.equal(dry.plan.changes.length,3);
 const confirmed={...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};identity='replacement';await assert.rejects(service.call('transform_midi_notes',confirmed),/changed|mismatch/);identity='original';
 assert.equal((await service.call('transform_midi_notes',confirmed)).observed.reversalVerified,false);
 await assert.rejects(service.call('transform_midi_notes',confirmed));assert.equal(writes,1);
});

test('reverse workflow and strict transform schema are available without Live',async()=>{
 validateToolArguments('transform_midi_notes',{trackId:'track-0',clipId:'track-0:clip-0',expectedStateVersion:4,noteIds:[1],operation});
 const service=new ToolService({bridge:{request:async()=>{throw Error('must not access Live');}}});
 for(const mode of ['copy','in-place']){
  const args={request:'Play this phrase backward; keep my original.',mode};
  const result=await service.call('get_producer_workflow',{workflow:'reverse-midi-phrase',arguments:args});assert.deepEqual(result.messages,getPrompt('reverse-midi-phrase',args).messages);
  for(const phrase of ['reverseTime','duration','hidden expression','copy','same-pitch','lost reply'])assert.ok(result.messages[0].content.text.toLowerCase().includes(phrase.toLowerCase()),phrase);
 }
 assert.throws(()=>getPrompt('reverse-midi-phrase',{request:'reverse',mode:'anything'}));
});

test('dense legal material and randomized retained-overlap checks match a pairwise oracle',()=>{
 const dense=Array.from({length:4096},(_,i)=>note(i,60,i<2048?i*.2:1100+(i-2048)*.2,.05));
 assert.equal(planMidiRetrograde(dense,Array.from({length:2048},(_,i)=>i),{type:'reverseTime',startBeats:0,endBeats:1024}).length,2048);
 let seed=17;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 const overlap=(a,b)=>Math.max(a.start,b.start)<Math.min(a.start+a.duration,b.start+b.duration)-2e-7;
 for(let run=0;run<100;run++){
  const source=Array.from({length:12},(_,i)=>note(i,60+Math.floor(rand()*3),Math.floor(rand()*24)/4,(1+Math.floor(rand()*6))/4));
  const ids=source.filter(()=>rand()<.5).map(n=>n.noteId);if(!ids.length)ids.push(0);
  const after=source.map(n=>ids.includes(n.noteId)?{...n,start:8-(n.start+n.duration)}:n);
  const conflict=source.some((a,i)=>source.some((b,j)=>j>i&&a.pitch===b.pitch&&overlap(after[i],after[j])&&!overlap(a,b)));
  if(conflict)assert.throws(()=>planMidiRetrograde(source,ids,{type:'reverseTime',startBeats:0,endBeats:8}),/overlap/);
  else assert.doesNotThrow(()=>planMidiRetrograde(source,ids,{type:'reverseTime',startBeats:0,endBeats:8}));
 }
});
