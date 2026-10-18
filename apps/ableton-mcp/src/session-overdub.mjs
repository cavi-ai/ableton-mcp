import {hashPlan} from './confirmation-store.mjs';

export async function sessionOverdub(bridge,confirmations,name,args){
  const target={trackId:args.trackId,clipId:args.clipId};
  if(name==='get_session_midi_overdub_context')return bridge.request(name,target);
  if(typeof args.enabled!=='boolean')throw Error('enabled must be boolean');
  if(!Number.isInteger(args.expectedStateVersion))throw Error('expectedStateVersion is required');
  const before=await bridge.request('get_session_midi_overdub_context',target);
  if(before.stateVersion!==args.expectedStateVersion||before.trackId!==target.trackId||before.clipId!==target.clipId)
    throw Error('Session overdub identity or state changed; re-read before retrying');
  if(before.sessionRecord===args.enabled)throw Error('Session recording already matches the request; inspect instead of replaying');
  const plan={method:name,...target,enabled:args.enabled,expectedStateVersion:args.expectedStateVersion,before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:args.enabled
    ?'Starts open-ended native Session MIDI overdub now on the already playing target. Recording continues after client disconnect until an explicit stop. No fixed duration or automatic cleanup. Native recording can change same-pitch notes; preserve the original in a separate clip. Inspect after uncertainty; never replay a start blindly. No incoming-performance or audible verification.'
    :'Stops the global Session recording switch only with this exact playing target and other explicit/implicit arms off. Keeps playback and arms unchanged. Retains all recorded material and manual edits; inspect actual clip flags and complete notes before claiming the take finished.'};
  if(args.planHash!==hashPlan(plan))throw Error('confirmation plan hash mismatch: Session overdub context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request(name,plan)};
}
