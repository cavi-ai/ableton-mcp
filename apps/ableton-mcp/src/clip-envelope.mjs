import {assertExpectedState} from "./bridge-protocol.mjs";
import {hashPlan} from "./confirmation-store.mjs";

export async function createClipParameterEnvelope(bridge,confirmations,args){
  if(!Number.isInteger(args.expectedStateVersion))throw Error("expectedStateVersion required");
  if(!Array.isArray(args.points)||args.points.length<1||args.points.length>128)throw Error("points must contain 1 to 128 steps");
  const request={trackId:args.trackId,clipId:args.clipId,deviceId:args.deviceId,parameterId:args.parameterId,points:args.points};
  const before=await bridge.request("get_clip_envelope_creation_context",request);
  assertExpectedState(args,before);
  if(before.envelopeExists!==false)throw Error("existing envelope is preserved; choose another clip or parameter");
  if(["trackId","clipId","deviceId","parameterId"].some(key=>before[key]!==args[key])||
    ["identityToken","contentDigest","parametersDigest"].some(key=>typeof before[key]!=="string")||!Array.isArray(before.points)||before.points.length!==args.points.length)throw Error("updated bridge envelope creation context required");
  const plan={method:"create_clip_parameter_envelope",...request,expectedStateVersion:args.expectedStateVersion,before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:"Creates only an absent Session device-parameter envelope. Samples verify requested steps, not a complete curve, other envelopes, hidden state or audible output. Parameter ownership/value may change. Playback and saving are separate."};
  const hash=hashPlan(plan);
  if(args.planHash!==hash)throw Error("confirmation plan hash mismatch: clip envelope context changed");
  confirmations.consume(args.confirmationToken,hash);
  const observed=await bridge.request("create_clip_parameter_envelope",plan);
  if(observed.stateVersion!==args.expectedStateVersion+1||observed.created!==true||observed.verified!==true||observed.verificationScope!=="sampled_steps"||
    ["trackId","clipId","deviceId","parameterId"].some(key=>observed[key]!==args[key]))throw Error("envelope creation readback mismatch; inspect current lane before retrying");
  return {dryRun:false,requested:plan,observed};
}
