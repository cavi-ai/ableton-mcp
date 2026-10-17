import {hashPlan} from './confirmation-store.mjs';

function request(args) {
  if (('position' in args) === ('assignments' in args)) throw Error('request assignments or position in separate confirmed steps');
  if ('position' in args) {
    if (typeof args.position !== 'number' || !Number.isFinite(args.position) || args.position < -1 || args.position > 1)
      throw Error('crossfader position must be finite and between -1 and 1');
    return {position: args.position};
  }
  const items = args.assignments;
  if (!Array.isArray(items) || items.length < 1 || items.length > 64 ||
      items.some(x => !x || typeof x.trackId !== 'string' || !/^(track|return)-(0|[1-9][0-9]*)$/.test(x.trackId) || !['A','none','B'].includes(x.side)) ||
      new Set(items.map(x=>x.trackId)).size !== items.length) throw Error('assignments require 1-64 unique track/Return IDs and A, none or B');
  return {assignments: items.map(({trackId,side})=>({trackId,side}))};
}

function assertEditable(before, input) {
  const p=before.position, t=before.transport;
  if (!before.identityToken || !p?.supported || p.enabled !== true || p.quantized !== false || p.automationState?.value !== 0 || p.automationState?.name !== 'none')
    throw Error('Main crossfader must be available, enabled, continuous and have known inactive automation');
  if (t?.arrangementRecord || t?.sessionRecord || t?.countingIn) throw Error('resolve recording and count-in before changing crossfader state');
  if (!Array.isArray(before.tracks) || before.tracks.some(r=>!r.assignment?.supported || !['A','none','B'].includes(r.assignment.name)))
    throw Error('native crossfader assignments must be available and known');
  if (input.assignments?.some(x=>!before.tracks.some(r=>r.trackId===x.trackId))) throw Error('crossfader target track or Return is unavailable');
  if ('position' in input && (input.position<p.min || input.position>p.max)) throw Error('crossfader position is outside native bounds; no clamping');
}

export async function crossfaderState(bridge, confirmations, name, args) {
  if (name==='get_crossfader_context') return bridge.request(name, {});
  const input=request(args);
  if (!Number.isInteger(args.expectedStateVersion)) throw Error('expectedStateVersion is required');
  const before=await bridge.request('get_crossfader_context', {});
  if (before.stateVersion!==args.expectedStateVersion) throw Error('crossfader state changed');
  assertEditable(before,input);
  const plan={method:'set_crossfader_state',...input,expectedStateVersion:args.expectedStateVersion,before};
  if (args.dryRun!==false) return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:
    'The Main crossfader affects every assigned track, Group and Return. Review all existing A/B members and hierarchy; assignment changes at the current position can change sound immediately. Setup and position movement require separate confirmations. Requests are immediate, not a timed fade, atomic audio transition or audible-balance proof. No transport, volume, pan, routing, send or curve changes are requested. Partial work is retained without automatic rollback or replay.'};
  if (args.planHash!==hashPlan(plan)) throw Error('confirmation plan hash mismatch: crossfader context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
