import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

const fields=['pitch','start','duration','velocity','velocityDeviation','releaseVelocity','probability','mute'];
function additions(notes,existing){
 if(!Array.isArray(notes)||!notes.length||notes.length>4096||existing.length+notes.length>4096)
  throw Error('insert 1–4096 notes with at most 4096 final notes');
 const result=[];
 for(const spec of notes){
  if(!spec||typeof spec!=='object'||Object.keys(spec).some(key=>!fields.includes(key)))throw Error('invalid new note fields');
  const note={velocityDeviation:0,releaseVelocity:64,probability:1,mute:false,...spec};
  for(const [key,low,high] of [['pitch',0,127],['velocity',1,127],['velocityDeviation',-127,127],['releaseVelocity',0,127]])
   if(!Number.isInteger(note[key])||note[key]<low||note[key]>high)throw Error(`invalid note ${key}`);
  if(!Number.isFinite(note.start)||note.start<0||!Number.isFinite(note.duration)||note.duration<=0||
   !Number.isFinite(note.start+note.duration)||!Number.isFinite(note.probability)||note.probability<0||note.probability>1||typeof note.mute!=='boolean')
   throw Error('invalid note values');
  if([...existing,...result].some(other=>note.pitch===other.pitch&&Math.max(note.start,other.start)<Math.min(note.start+note.duration,other.start+other.duration)))
   throw Error('same-pitch overlap would risk altering existing or added notes');
  result.push(note);
 }
 return result;
}

export async function midiInsertion(bridge,confirmations,name,args){
 const target={trackId:args.trackId,clipId:args.clipId};
 if(name==='get_midi_note_insertion_context')return bridge.request(name,target);
 const before=await bridge.request('get_midi_note_insertion_context',target);assertExpectedState(args,before);
 if(before.trackId!==target.trackId||before.clipId!==target.clipId||!before.identityToken||before.insertSupported!==true||
  !Array.isArray(before.notes)||!before.clipTiming||
  ['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'].some(key=>before.editContext?.[key]!==false))
  throw Error('resolve native insertion support, target identity, frozen state, recording, count-in and pending launch');
 const plan={method:'insert_midi_notes',...target,expectedStateVersion:args.expectedStateVersion,before,notes:additions(args.notes,before.notes)};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:
  'Adds explicit notes without replacing existing notes. Same-pitch overlaps refuse. Partial native work is retained; inspect all notes after an uncertain reply before adding remaining notes. No automatic rollback, replay or audible verification.'};
 const hash=hashPlan(plan);if(args.planHash!==hash)throw Error('confirmation plan hash mismatch: MIDI insertion source changed');
 confirmations.consume(args.confirmationToken,hash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
