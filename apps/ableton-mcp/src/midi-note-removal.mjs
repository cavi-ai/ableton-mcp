import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function midiNoteRemoval(bridge,confirmations,name,args){
 const target={trackId:args.trackId,clipId:args.clipId};
 if(name==='get_midi_note_removal_context')return bridge.request(name,target);
 const before=await bridge.request('get_midi_note_removal_context',target);assertExpectedState(args,before);
 if(before.trackId!==target.trackId||before.clipId!==target.clipId||typeof before.identityToken!=='string'||!before.identityToken||
  before.removeSupported!==true||!Array.isArray(before.notes)||before.notes.length>4096||!before.clipTiming||
  ['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'].some(key=>before.editContext?.[key]!==false))
  throw Error('resolve native removal support, target identity, frozen state, recording, count-in and pending launch');
 if(!Array.isArray(args.noteIds)||!args.noteIds.length||args.noteIds.length>4096||
  args.noteIds.some(id=>!Number.isSafeInteger(id)||id<0)||new Set(args.noteIds).size!==args.noteIds.length)
  throw Error('1–4096 unique nonnegative integer note IDs required');
 const noteIds=[...args.noteIds].sort((a,b)=>a-b),old=new Map(before.notes.map(note=>[note.noteId,note]));
 if(old.size!==before.notes.length||noteIds.some(id=>!old.has(id)))throw Error('one or more requested note IDs no longer exist');
 const plan={method:'remove_midi_notes',...target,expectedStateVersion:args.expectedStateVersion,before,noteIds};
 if(args.dryRun!==false)return {dryRun:true,plan,removedNotes:noteIds.map(id=>old.get(id)),confirmation:confirmations.issue(plan),warning:
  'Destructive: removes the exact notes and their hidden expression. Exposed note records are not a complete backup. Use mute for a reversible simplification. Partial deletions remain; read actual notes before planning remaining work. No automatic rollback, reconstruction, replay or audible verification.'};
 const hash=hashPlan(plan);if(args.planHash!==hash)throw Error('confirmation plan hash mismatch: MIDI removal source changed');
 confirmations.consume(args.confirmationToken,hash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
