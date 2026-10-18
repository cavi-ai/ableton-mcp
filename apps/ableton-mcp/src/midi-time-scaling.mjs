import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

const editFlags=['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'];
const exactFields=['pitch','velocity','velocityDeviation','releaseVelocity','probability','mute'];

function changesFor(before,noteIds,operation) {
  if(Object.keys(operation).sort().join(',')!=='factor,originBeats,type')
    throw Error('scaleTime requires only type, factor and originBeats');
  const {factor,originBeats}=operation;
  if(typeof factor!=='number'||!Number.isFinite(factor)||factor<.25||factor>4||factor===1)
    throw Error('scaleTime factor must be from 0.25 to 4 and different from 1');
  const timing=before.clipTiming,region=timing.loop.enabled?timing.loop:timing.markers;
  if(typeof timing.loop.enabled!=='boolean'||timing.markers.unit!=='beats'||
    !Number.isFinite(region.startBeats)||region.startBeats<0||!Number.isFinite(region.endBeats)||region.endBeats<=region.startBeats)
    throw Error('scaleTime requires known absolute MIDI playback bounds');
  if(typeof originBeats!=='number'||!Number.isFinite(originBeats)||originBeats<region.startBeats||originBeats>=region.endBeats)
    throw Error('scaleTime originBeats must be an explicit clip-beat anchor within the playback region');
  if(!Array.isArray(noteIds)||!noteIds.length||noteIds.length>4096||
    noteIds.some(id=>!Number.isSafeInteger(id)||id<0)||new Set(noteIds).size!==noteIds.length)
    throw Error('scaleTime requires 1–4096 unique nonnegative integer note IDs');
  const old=new Map(before.notes.map(n=>[n.noteId,n]));
  if(old.size!==before.notes.length||noteIds.some(id=>!old.has(id)))throw Error('unknown or duplicate native noteId');
  const changes=[...noteIds].sort((a,b)=>a-b).map(noteId=>{
    const previous=old.get(noteId),start=originBeats+(previous.start-originBeats)*factor,duration=previous.duration*factor;
    if(!Number.isFinite(previous.start)||!Number.isFinite(previous.duration)||previous.duration<=0||
      !Number.isFinite(start)||!Number.isFinite(duration)||duration<1e-6||start<region.startBeats||start+duration>region.endBeats)
      throw Error(`noteId ${noteId} scales outside playback bounds or below minimum duration; no clipping or resizing`);
    return {noteId,previous,start,duration};
  });
  const changed=new Map(changes.map(c=>[c.noteId,c]));
  const final=before.notes.map(n=>({...n,...(changed.has(n.noteId)?{start:changed.get(n.noteId).start}: {})}))
    .sort((a,b)=>a.pitch-b.pitch||a.start-b.start);
  for(let i=1;i<final.length;i++)
    if((changed.has(final[i].noteId)||changed.has(final[i-1].noteId))&&final[i].pitch===final[i-1].pitch&&
      Math.abs(final[i].start-final[i-1].start)<1e-9)throw Error('scaleTime creates a same-pitch onset collision');
  return changes;
}

function check(before,changes,after) {
  if(!after)return false;
  const current=new Map(after.notes?.map(n=>[n.noteId,n])??[]),changed=new Map(changes.map(c=>[c.noteId,c]));
  return current.size===before.notes.length&&after.notes.length===before.notes.length&&before.notes.every(n=>{
    const actual=current.get(n.noteId),c=changed.get(n.noteId);
    return actual&&exactFields.every(k=>actual[k]===n[k])&&
      Math.abs(actual.start-(c?.start??n.start))<=2e-7&&Math.abs(actual.duration-(c?.duration??n.duration))<=2e-7;
  });
}

export async function scaleMidiTime(bridge,confirmations,args) {
  const target={trackId:args.trackId,clipId:args.clipId};
  // The existing context supplies complete notes, strict edit flags and native identity.
  const before=await bridge.request('get_midi_note_removal_context',target);assertExpectedState(args,before);
  if(before.trackId!==target.trackId||before.clipId!==target.clipId||!before.identityToken||!before.setFingerprint||
    !Array.isArray(before.notes)||before.notes.length>4096||!before.clipTiming||
    editFlags.some(key=>before.editContext?.[key]!==false))
    throw Error('resolve MIDI identity, playback bounds, frozen state, recording, count-in and pending launch');
  const changes=changesFor(before,args.noteIds,args.operation);
  const plan={method:'transform_midi_notes',...target,expectedStateVersion:args.expectedStateVersion,
    before,noteIds:changes.map(c=>c.noteId),operation:args.operation,changes,newNotes:[]};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:
    'Scales stored note starts and durations only. Tempo, loop and placement are not resized. Hidden per-note expression and clip envelopes are not retimed or verified. Notes outside playback bounds refuse. Partial native edits remain; inspect before further work.'};
  const hash=hashPlan(plan);if(args.planHash!==hash)throw Error('confirmation plan hash mismatch: MIDI time-scaling source changed');
  confirmations.consume(args.confirmationToken,hash);
  const observed=await bridge.request(plan.method,plan);
  let readback=null,error=null;
  try {readback=await bridge.request('get_midi_note_removal_context',target);}catch(failure){error=String(failure.message??failure);}
  const targetRetained=readback?.trackId===target.trackId&&readback?.clipId===target.clipId&&
    readback?.identityToken===before.identityToken&&readback?.setFingerprint===before.setFingerprint;
  const boundsUnchanged=!!readback&&hashPlan({...readback.clipTiming,stateVersion:before.clipTiming.stateVersion})===hashPlan(before.clipTiming);
  const notesConfirmed=check(before,changes,readback);
  return {dryRun:false,requested:plan,observed,readback,verification:{
    confirmed:observed.nativeReturned===true&&observed.timeScalingVerified===true&&!observed.error&&
      targetRetained&&boundsUnchanged&&notesConfirmed&&readback?.stateVersion===args.expectedStateVersion+1,
    notesConfirmed,boundsUnchanged,targetRetained,error,
    scope:'Complete exposed note records, playback bounds and native target; hidden expression, envelopes and audible outcome are not verified.'}};
}
