import {hashPlan} from './confirmation-store.mjs';

const modes={stereo:0,splitStereo:1},controls=['pan','left','right'];

export function assertStereoPan(pan){
  const mode=pan?.panningMode;
  if(mode?.supported!==true||mode.value!==0||mode.name!=='stereo')
    throw Error('single-pan edits require observed Stereo mode; use mode-aware mixer panning for Split Stereo');
}

function request(args){
  const values=Object.fromEntries(controls.filter(k=>k in args).map(k=>[k,args[k]]));
  if('mode' in args){
    if(Object.keys(values).length||typeof args.mode!=='string'||!Object.hasOwn(modes,args.mode))throw Error('mode setup and positions require separate confirmed steps');
    return {mode:args.mode};
  }
  if(!Object.keys(values).length||('pan' in values&&Object.keys(values).length!==1))throw Error('request Stereo pan or Split Stereo left/right controls');
  if(Object.values(values).some(v=>typeof v!=='number'||!Number.isFinite(v)||v < -1||v > 1))throw Error('pan values must be finite and between -1 and 1; no clamping');
  return values;
}

function assertEditable(before,input,trackId){
  if(!before.identityToken||before.trackId!==trackId||before.mode?.supported!==true||modes[before.mode.name]!==before.mode.value)
    throw Error('updated native panning identity and known mode required');
  const t=before.transport;
  if(!t||t.arrangementRecord!==false||t.sessionRecord!==false||t.countingIn!==false||before.frozen!==false)
    throw Error('resolve recording, count-in and frozen or unknown target state before panning');
  if(!('mode' in input)&&before.mode.name!==('pan' in input?'stereo':'splitStereo'))throw Error('requested controls do not match the active panning mode');
  for(const key of 'mode' in input?controls:Object.keys(input)){
    const p=before.parameters?.[key];
    if(p?.supported!==true||p.quantized!==false||p.automationState?.value!==0||p.automationState?.name!=='none')
      throw Error('affected pan parameters must be available, continuous and have known inactive automation');
    if(!('mode' in input)&&(p.enabled!==true||!Number.isFinite(p.min)||!Number.isFinite(p.max)||p.min>=p.max||input[key]<p.min||input[key]>p.max))
      throw Error('active pan control must be enabled and requested value within native bounds; no clamping');
  }
}

export async function mixerPanning(bridge,confirmations,name,args){
  if(typeof args.trackId!=='string'||!/^(master|(track|return)-(0|[1-9][0-9]*))$/.test(args.trackId))throw Error('canonical track, Group, Return or master ID required');
  if(name==='get_mixer_panning_context')return bridge.request(name,{trackId:args.trackId});
  const input=request(args);
  if(!Number.isInteger(args.expectedStateVersion))throw Error('expectedStateVersion required');
  const before=await bridge.request('get_mixer_panning_context',{trackId:args.trackId});
  if(before.stateVersion!==args.expectedStateVersion)throw Error('panning state changed');
  assertEditable(before,input,args.trackId);
  const plan={method:'set_mixer_panning',trackId:args.trackId,...input,expectedStateVersion:args.expectedStateVersion,before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:
    'Mode setup and position changes require separate confirmations. A mode switch can change all native pan controls; inspect their actual values before another edit. Left/right place the input channels, not independent output gains. Group, Return and Main edits affect their entire mixer stage. Immediate values are not a timed sweep, width percentage, loudness or audible image verification. Partial work remains without automatic rollback or replay.'};
  if(args.planHash!==hashPlan(plan))throw Error('confirmation plan hash mismatch: panning context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
