import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';
const epsilon=2e-7;
function tree(values,combine){
 const result=Array(values.length).fill(0).concat(values);
 for(let i=values.length-1;i>0;i--)result[i]=combine(result[i*2],result[i*2+1]);
 return result;
}
function range(values,left,right,combine,neutral){
 let result=neutral;left+=values.length/2;right+=values.length/2;
 while(left<right){if(left%2)result=combine(result,values[left++]);if(right%2)result=combine(result,values[--right]);left=Math.floor(left/2);right=Math.floor(right/2);}
 return result;
}
function bound(values,target,upper=false){
 let left=0,right=values.length;
 while(left<right){const middle=Math.floor((left+right)/2);if(values[middle]<target||(upper&&values[middle]===target))left=middle+1;else right=middle;}
 return left;
}
function collisionIndex(notes,selected){
 const buckets=new Map(),result=new Map();
 for(const n of notes)if(!selected.has(n.noteId)&&n.duration>epsilon){if(!buckets.has(n.pitch))buckets.set(n.pitch,[]);buckets.get(n.pitch).push(n);}
 for(const [pitch,retained] of buckets){
  const byStart=[...retained].sort((a,b)=>a.start-b.start),byEnd=[...retained].sort((a,b)=>(a.start+a.duration)-(b.start+b.duration));
  result.set(pitch,{starts:byStart.map(n=>n.start),maximumEnds:tree(byStart.map(n=>n.start+n.duration),Math.max),ends:byEnd.map(n=>n.start+n.duration),minimumStarts:tree(byEnd.map(n=>n.start),Math.min)});
 }
 return result;
}
function newCollision(change,index){
 const old=change.previous,data=index.get(old.pitch);if(!data||old.duration<=epsilon)return false;
 const start=change.start,end=start+old.duration;
 if(start>old.start)return range(data.maximumEnds,bound(data.starts,old.start+old.duration-epsilon),bound(data.starts,end-epsilon),Math.max,-Infinity)>start+epsilon;
 return range(data.minimumStarts,bound(data.ends,start+epsilon,true),bound(data.ends,old.start+epsilon,true),Math.min,Infinity)<end-epsilon;
}

export function planMidiRetrograde(notes,noteIds,operation){
 if(!operation||Object.keys(operation).sort().join(',')!=='endBeats,startBeats,type'||operation.type!=='reverseTime')throw Error('reverseTime requires exactly startBeats and endBeats');
 const {startBeats:start,endBeats:end}=operation;
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>1024)throw Error('finite nonnegative increasing clip-beat window of at most 1024 beats required');
 if(!Array.isArray(notes)||notes.length>4096||notes.some(n=>!Number.isSafeInteger(n?.noteId)||n.noteId<0||!Number.isInteger(n.pitch)||n.pitch<0||n.pitch>127||!Number.isFinite(n.start)||n.start<0||!Number.isFinite(n.duration)||n.duration<=0||!Number.isFinite(n.start+n.duration))||new Set(notes.map(n=>n.noteId)).size!==notes.length)throw Error('complete finite source notes with unique native IDs required');
 if(!Array.isArray(noteIds)||!noteIds.length||noteIds.length>4096||noteIds.some(i=>!Number.isSafeInteger(i)||i<0)||new Set(noteIds).size!==noteIds.length)throw Error('1–4096 unique native note IDs required');
 const old=new Map(notes.map(n=>[n.noteId,n])),changes=[];
 for(const noteId of [...noteIds].sort((a,b)=>a-b)){
  const previous=old.get(noteId);if(!previous)throw Error('unknown note ID');
  if(previous.start<start||previous.start+previous.duration>end)throw Error('selected whole note span lies outside the reversal window');
  const reflected=start+(end-(previous.start+previous.duration));if(reflected!==previous.start)changes.push({noteId,previous,start:reflected});
 }
 // Full-span reflection preserves selected/selected overlap; query retained notes only.
 const index=collisionIndex(notes,new Set(noteIds));
 if(changes.some(change=>newCollision(change,index)))throw Error('reversal would create a new same-pitch overlap');
 return changes;
}

export async function reverseMidiPhrase(bridge,confirmations,args){
 const target={trackId:args.trackId,clipId:args.clipId},before=await bridge.request('get_midi_retrograde_context',target);
 assertExpectedState(args,before);
 if(before.trackId!==target.trackId||before.clipId!==target.clipId||typeof before.identityToken!=='string'||!before.identityToken||before.modifySupported!==true||!before.clipTiming||['frozen','clipRecording','clipOverdubbing','pendingLaunch','arrangementRecord','sessionRecord','countingIn'].some(k=>before.editContext?.[k]!==false))throw Error('resolve native reversal support, identity, recording, frozen state and pending launch');
 const changes=planMidiRetrograde(before.notes,args.noteIds,args.operation);
 const plan={method:'transform_midi_notes',...target,expectedStateVersion:args.expectedStateVersion,before,operation:args.operation,noteIds:[...args.noteIds].sort((a,b)=>a-b),changes};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('MIDI reversal confirmation context changed');
 confirmations.consume(args.confirmationToken,args.planHash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
