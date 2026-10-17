import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAudioMidiSketch} from '../src/audio-midi-sketch.mjs';
import {getPrompt} from '../src/prompts.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ToolService} from '../src/tool-service.mjs';

const source={stateVersion:3,trackId:'track-0',clipId:'track-0:clip-0',
  region:{kind:'loop',startBeats:8,endBeats:16},timeSignature:{numerator:4,denominator:4},
  sourceWindow:{startSeconds:2,durationSeconds:4},audioState:{pitch:{coarse:0,fine:0}}};
const events=[{midiNote:60,startSeconds:2,endSeconds:3,medianCentsFromNote:4},
  {midiNote:64,startSeconds:4,endSeconds:6,medianCentsFromNote:-2}];
const converted={conversion:'native',points:[{sourceSeconds:2,beatTime:8},{sourceSeconds:3,beatTime:10},
  {sourceSeconds:4,beatTime:12},{sourceSeconds:6,beatTime:16}]};

test('nonuniform native warp positions become relative MIDI beats with explicit assigned velocity',()=>{
  const warped={...converted,points:converted.points.map((point,index)=>({...point,beatTime:[8,9,11,16][index]}))};
  const p=buildAudioMidiSketch(source,{events,boundaryUncertaintySeconds:0.128},warped,91);
  assert.equal(p.lengthBeats,8);
  assert.deepEqual(p.notes,[{pitch:60,start:0,duration:1,velocity:91},{pitch:64,start:3,duration:5,velocity:91}]);
  assert.equal(p.velocitySource,'assigned_uniform');
  assert.equal(p.pitchBasis,'untransposed_source_audio');
  assert.equal(p.audioCorrectionApplied,false);
});

test('note boundaries trim to the requested clip region while preserving leading silence',()=>{
  const p=buildAudioMidiSketch(source,{events:[events[0]],boundaryUncertaintySeconds:0.128},
    {conversion:'native',points:[{sourceSeconds:2,beatTime:9},{sourceSeconds:3,beatTime:18}]},100);
  assert.deepEqual(p.notes,[{pitch:60,start:1,duration:7,velocity:100}]);
});

test('empty candidates remain empty and mismatched or reversed native mappings fail',()=>{
  assert.deepEqual(buildAudioMidiSketch(source,{events:[],boundaryUncertaintySeconds:0.128},{conversion:'native',points:[]},100).notes,[]);
  for(const points of [converted.points.slice(1),converted.points.map((p,i)=>({...p,sourceSeconds:i})),
    converted.points.map(p=>({...p,beatTime:-p.beatTime}))])assert.throws(()=>buildAudioMidiSketch(source,{events}, {conversion:'native',points},100));
});

test('audio-to-MIDI workflow preserves audio and distinguishes sketch from transcription',()=>{
  const text=getPrompt('sketch-midi-from-audio',{request:'Make this isolated bass phrase playable with another instrument'}).messages[0].content.text;
  for(const name of ['plan_audio_midi_sketch','create_midi_clip','get_midi_clip_notes_extended','get_audio_clip_state','get_transport_recording_context'])assert.ok(text.includes(name),name);
  assert.match(text,/polyphonic/i);assert.match(text,/manual edits/i);assert.match(text,/uniform velocity/i);
  assert.match(text,/source audio/i);assert.match(text,/approximate/i);
});

test('planner analyzes real audio and refuses changed native context instead of returning stale notes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'audio-midi-'));
  try{
    const path=join(directory,'phrase.wav');
    await promisify(execFile)('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',
      'aevalsrc=0.2*sin(2*PI*if(lt(t\\,1)\\,220\\,330)*t):s=48000:d=2',path]);
    let reads=0,changed=false;
    const context={...source,region:{kind:'loop',startBeats:0,endBeats:4},
      sourceWindow:{startSeconds:0,durationSeconds:2,sampleRate:48000},
      audioState:{warping:true,pitch:{coarse:0,fine:0},source:{path}}};
    const service=new ToolService({bridge:{async request(method,args){
      if(method==='get_audio_midi_sketch_source'){reads++;return structuredClone(changed&&reads%2===0?
        {...context,audioState:{...context.audioState,pitch:{coarse:1,fine:0}}}:context);}
      assert.equal(method,'get_audio_source_beat_times');
      return {stateVersion:3,trackId:'track-0',clipId:'track-0:clip-0',sourcePath:path,conversion:'native',
        points:args.sourceSeconds.map(sourceSeconds=>({sourceSeconds,beatTime:sourceSeconds*2}))};
    }}});
    const result=await service.call('plan_audio_midi_sketch',{trackId:'track-0',clipId:'track-0:clip-0',velocity:88});
    assert.equal(result.eligible,true);
    assert.deepEqual([...new Set(result.notes.map(n=>n.pitch))],[57,64]);
    assert.ok(result.notes.every(n=>n.velocity===88&&n.start>=0&&n.start+n.duration<=4));
    assert.equal(result.sourceFile.verification,'metadata_unchanged');
    changed=true;
    await assert.rejects(()=>service.call('plan_audio_midi_sketch',{trackId:'track-0',clipId:'track-0:clip-0'}),/changed/);
    changed=false;
    context.sourceWindow.sampleRate=44100;
    await assert.rejects(()=>service.call('plan_audio_midi_sketch',{trackId:'track-0',clipId:'track-0:clip-0'}),/sample rate/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
