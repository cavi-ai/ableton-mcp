import {assertExpectedState} from "./bridge-protocol.mjs";
import {hashPlan} from "./confirmation-store.mjs";

export async function createClipParameterEnvelope(bridge,confirmations,args){
  return createEnvelope(bridge,confirmations,args,false);
}

function mixerSelector(args){
  if(args.mixerControl==='volume'){
    if(args.sendId!==undefined||args.returnTrackId!==undefined)throw Error('volume envelopes do not accept send or Return IDs');
    return {mixerControl:'volume'};
  }
  if(args.mixerControl!=='send')throw Error('mixerControl must be volume or send');
  if(typeof args.sendId!=='string'||!/^send-(0|[1-9][0-9]*)$/.test(args.sendId))throw Error('canonical sendId required');
  if(args.returnTrackId!==args.sendId.replace('send-','return-'))throw Error('sendId and returnTrackId must match');
  return {mixerControl:'send',sendId:args.sendId,returnTrackId:args.returnTrackId};
}

export async function createClipMixerEnvelope(bridge,confirmations,args){
  return createEnvelope(bridge,confirmations,args,true);
}

async function createEnvelope(bridge,confirmations,args,mixer){
  if(!Number.isInteger(args.expectedStateVersion))throw Error("expectedStateVersion required");
  if(!Array.isArray(args.points)||args.points.length<1||args.points.length>128)throw Error("points must contain 1 to 128 steps");
  const selector=mixer?mixerSelector(args):{deviceId:args.deviceId,parameterId:args.parameterId};
  const request={trackId:args.trackId,clipId:args.clipId,...selector,points:args.points};
  const method=mixer?'create_clip_mixer_envelope':'create_clip_parameter_envelope';
  const keys=['trackId','clipId',...Object.keys(selector)];
  const before=await bridge.request(mixer?'get_clip_mixer_envelope_creation_context':'get_clip_envelope_creation_context',request);
  assertExpectedState(args,before);
  if(before.envelopeExists!==false)throw Error("existing envelope is preserved; choose another clip or parameter");
  if(keys.some(key=>before[key]!==args[key])||
    ["identityToken","contentDigest","parametersDigest"].some(key=>typeof before[key]!=="string")||!Array.isArray(before.points)||before.points.length!==args.points.length)throw Error("updated bridge envelope creation context required");
  const plan={method,...request,expectedStateVersion:args.expectedStateVersion,before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:`Creates only an absent Session ${mixer?'track mixer':'device-parameter'} envelope. Samples verify requested steps, not a complete curve, other envelopes, hidden state or audible output. Parameter ownership/value may change. Playback and saving are separate.`};
  const hash=hashPlan(plan);
  if(args.planHash!==hash)throw Error("confirmation plan hash mismatch: clip envelope context changed");
  confirmations.consume(args.confirmationToken,hash);
  const observed=await bridge.request(method,plan);
  if(observed.stateVersion!==args.expectedStateVersion+1||observed.created!==true||observed.verified!==true||observed.verificationScope!=="sampled_steps"||
    keys.some(key=>observed[key]!==args[key]))throw Error("envelope creation readback mismatch; inspect current lane before retrying");
  return {dryRun:false,requested:plan,observed};
}

export async function replaceClipParameterEnvelope(bridge,confirmations,args){
  if(!Number.isInteger(args.expectedStateVersion))throw Error("expectedStateVersion required");
  if(!Array.isArray(args.points)||args.points.length<1||args.points.length>512)throw Error("points must contain 1 to 512 ordered steps");
  if(args.replaceExisting!==undefined&&typeof args.replaceExisting!=="boolean")throw Error("replaceExisting must be a boolean");
  const request={trackId:args.trackId,clipId:args.clipId,deviceId:args.deviceId,parameterId:args.parameterId,points:args.points,replaceExisting:args.replaceExisting===true};
  const before=await bridge.request("get_clip_envelope_replacement_context",request);
  assertExpectedState(args,before);
  if(before.envelopeExists===true&&!request.replaceExisting)throw Error("replaceExisting: true is required to discard the entire existing envelope");
  if(typeof before.envelopeExists!=="boolean"||before.fullCurveCaptured!==false||
    ["trackId","clipId","deviceId","parameterId"].some(key=>before[key]!==args[key])||
    ["identityToken","contentDigest","parametersDigest"].some(key=>typeof before[key]!=="string")||!Array.isArray(before.points)||before.points.length!==args.points.length)throw Error("updated bridge envelope replacement context required");
  const plan={method:"set_clip_parameter_envelope",...request,expectedStateVersion:args.expectedStateVersion,points:before.points.map(({time,duration,requestedValue,value})=>({time,duration,requestedValue,value})),before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:before.envelopeExists?
    "Discards the entire existing envelope, including unsampled edits. Native identity and sampled context are rechecked, but the complete curve is not captured or backed up. Failure after clearing cannot restore it; inspect partial state before retrying.":
    "Creates an absent lane with guarded native context. Numeric values retain native clamping. Verification covers sampled step interiors; exact boundaries are reported separately."};
  const hash=hashPlan(plan);
  if(args.planHash!==hash)throw Error("confirmation plan hash mismatch: clip envelope replacement context changed");
  confirmations.consume(args.confirmationToken,hash);
  // Keep the original request values for the native preflight. The plan also
  // exposes their clamped targets; sending only targets would change its hash.
  const observed=await bridge.request("set_clip_parameter_envelope",{...plan,points:request.points});
  if(observed.stateVersion!==args.expectedStateVersion+1||observed.replaced!==true||observed.replacedExisting!==before.envelopeExists||observed.verified!==true||observed.verificationScope!=="sampled_steps"||
    ["trackId","clipId","deviceId","parameterId"].some(key=>observed[key]!==args[key]))throw Error("envelope replacement readback mismatch; inspect current lane before retrying");
  return {dryRun:false,requested:plan,observed};
}
