import {isDeepStrictEqual} from 'node:util';
import {realpath,stat} from 'node:fs/promises';
import {analyzeAudioFile} from './audio-analysis.mjs';

export function buildAudioMidiSketch(source, pitchEvents, converted, velocity=100) {
  const region=source?.region, events=pitchEvents?.events;
  if(!region||![region.startBeats,region.endBeats].every(Number.isFinite)||
    region.endBeats<=region.startBeats||region.endBeats-region.startBeats>256)throw Error('invalid clip beat region');
  if(!Number.isInteger(velocity)||velocity<1||velocity>127)throw Error('velocity must be an integer from 1 to 127');
  if(!Array.isArray(events)||events.length>128)throw Error('at most 128 pitch events can be proposed; choose a shorter region');
  if(converted?.conversion!=='native'||!Array.isArray(converted.points)||converted.points.length!==events.length*2)
    throw Error('complete native event boundary conversion required');
  const points=converted.points, notes=[], noteEvidence=[];
  events.forEach((event,index)=>{
    if(!Number.isInteger(event.midiNote)||event.midiNote<0||event.midiNote>127||
      ![event.startSeconds,event.endSeconds].every(Number.isFinite)||event.startSeconds<0||event.endSeconds<=event.startSeconds||
      (index&&event.startSeconds<events[index-1].endSeconds))throw Error('invalid ordered monophonic pitch events');
    const first=points[index*2],last=points[index*2+1];
    if(first.sourceSeconds!==event.startSeconds||last.sourceSeconds!==event.endSeconds||
      ![first.beatTime,last.beatTime].every(Number.isFinite)||last.beatTime<=first.beatTime||
      (index&&first.beatTime<points[index*2-1].beatTime))throw Error('native source boundary conversion mismatch');
    const start=Math.max(region.startBeats,first.beatTime),end=Math.min(region.endBeats,last.beatTime);
    if(end<=start)return;
    notes.push({pitch:event.midiNote,start:start-region.startBeats,duration:end-start,velocity});
    noteEvidence.push({eventIndex:index,sourceStartSeconds:event.startSeconds,sourceEndSeconds:event.endSeconds,
      medianCentsFromNote:event.medianCentsFromNote??null,clippedToRegion:start!==first.beatTime||end!==last.beatTime});
  });
  return {eligible:notes.length>0,reason:notes.length?'approximate_monophonic_candidates':'no_pitch_candidates_in_region',
    lengthBeats:region.endBeats-region.startBeats,notes,noteEvidence,region,timeSignature:source.timeSignature,
    pitchBasis:'untransposed_source_audio',clipPitch:source.audioState?.pitch,
    velocitySource:'assigned_uniform',velocity,timingBasis:'native_source_to_clip_beats',
    boundaryUncertaintySeconds:pitchEvents.boundaryUncertaintySeconds??null,audioCorrectionApplied:false,
    limitation:'Review-only monophonic source-audio sketch. Note boundaries and pitches are heuristic; fast repetitions, polyphony, vibrato and octave errors can be missed or split. Uniform velocity is assigned, not measured. Clip transposition, re-pitch playback, groove, envelopes and device processing are not rendered. No MIDI clip is created.'};
}

const identity=info=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(key=>[key,String(info[key])]));

export async function planAudioMidiSketch(bridge,args) {
  const target={trackId:args.trackId,clipId:args.clipId};
  const input={...target,...(args.startBeats===undefined?{}:{startBeats:args.startBeats}),
    ...(args.endBeats===undefined?{}:{endBeats:args.endBeats})};
  const before=await bridge.request('get_audio_midi_sketch_source',input);
  if(before.trackId!==target.trackId||before.clipId!==target.clipId)throw Error('audio clip identity mismatch');
  if(!before.audioState?.warping||!before.audioState.source?.path)throw Error('warped local audio source required');
  const window=before.sourceWindow;
  if(!window||!Number.isFinite(window.startSeconds)||window.startSeconds<0||
    !Number.isFinite(window.durationSeconds)||window.durationSeconds<0.256||window.durationSeconds>30||
    !Number.isFinite(window.sampleRate)||window.sampleRate<=0)
    throw Error('invalid bounded source window');
  const path=await realpath(before.audioState.source.path),file=await stat(path,{bigint:true});
  if(!file.isFile())throw Error('regular source audio file required');
  const measurement=await analyzeAudioFile(path,{startSeconds:window.startSeconds,durationSeconds:window.durationSeconds,
    channelIndex:args.channelIndex??0,includePitchEvents:true});
  if(measurement.sampleRate!==window.sampleRate)throw Error('source sample rate does not match native clip');
  if(Math.abs(measurement.window.durationSeconds-window.durationSeconds)>1/window.sampleRate)
    throw Error('decoded source window does not match native source region');
  const seconds=measurement.pitchEvents.events.flatMap(event=>[event.startSeconds,event.endSeconds]);
  if(seconds.length>256)throw Error('at most 128 pitch events can be proposed; choose a shorter region');
  const converted=seconds.length?await bridge.request('get_audio_source_beat_times',{...target,sourceSeconds:seconds}):
    {stateVersion:before.stateVersion,...target,sourcePath:before.audioState.source.path,conversion:'native',points:[]};
  if(converted.trackId!==target.trackId||converted.clipId!==target.clipId||converted.stateVersion!==before.stateVersion||
    converted.sourcePath!==before.audioState.source.path)throw Error('native conversion changed audio clip context');
  const after=await bridge.request('get_audio_midi_sketch_source',input),currentFile=await stat(path,{bigint:true});
  if(!isDeepStrictEqual(before,after)||!isDeepStrictEqual(identity(file),identity(currentFile))||
    await realpath(before.audioState.source.path)!==path)throw Error('audio clip or source file changed during proposal');
  return {stateVersion:after.stateVersion,...target,...buildAudioMidiSketch(after,measurement.pitchEvents,converted,args.velocity??100),
    sourceWindow:after.sourceWindow,channelIndex:args.channelIndex??0,
    sourceFile:{path,...identity(file),verification:'metadata_unchanged'},
    sourceContext:after,pitchEventCount:measurement.pitchEvents.events.length,
    unvoicedFrameCount:measurement.pitchEvents.unvoicedFrameCount,
    discardedShortRuns:measurement.pitchEvents.discardedShortRuns};
}
