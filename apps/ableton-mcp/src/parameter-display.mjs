import {assertExpectedState} from "./bridge-protocol.mjs";
import {guardedWrite} from "./guarded-write.mjs";

export async function setDeviceParameterDisplay(bridge,confirmations,args){
  if(typeof args.trackId!=="string"||!/^(?:(?:track|return)-(?:0|[1-9][0-9]*)|master)$/.test(args.trackId))throw Error("canonical device owner required");
  const path=typeof args.deviceId==="string"?args.deviceId.slice(args.trackId.length):undefined;
  if(typeof args.deviceId!=="string"||!args.deviceId.startsWith(args.trackId)||!/^:device-(?:0|[1-9][0-9]*)(?:\/(?:chain|return-chain)-(?:0|[1-9][0-9]*)\/device-(?:0|[1-9][0-9]*))*$/.test(path))throw Error("canonical device path required");
  if(typeof args.parameterId!=="string"||!/^parameter-(?:0|[1-9][0-9]*)$/.test(args.parameterId))throw Error("canonical parameterId required");
  if(typeof args.targetDisplay!=="string"||args.targetDisplay.length>96||!/^([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))\s*(Hz|kHz|ms|s|dB|%)$/.test(args.targetDisplay.trim().replaceAll("−","-")))throw Error("numeric target display with Hz, kHz, ms, s, dB or % unit required");
  if(!Number.isInteger(args.expectedStateVersion))throw Error("expectedStateVersion required");
  const request={trackId:args.trackId,deviceId:args.deviceId,parameterId:args.parameterId,targetDisplay:args.targetDisplay};
  const before=await bridge.request("get_device_parameter_display_context",request);
  assertExpectedState(args,before);
  if(before.trackId!==args.trackId||before.deviceId!==args.deviceId||before.parameterId!==args.parameterId||typeof before.identityToken!=="string"||typeof before.parametersDigest!=="string"||!Number.isFinite(before.target?.value)||!Number.isFinite(before.target?.quantity?.value))throw Error("updated bridge parameter-display context required");
  const plan={method:"set_device_parameter_display",...request,expectedStateVersion:args.expectedStateVersion,before};
  return guardedWrite(confirmations,plan,args,{mismatch:"confirmation plan hash mismatch: device parameter context changed",execute:async()=>{
    const observed=await bridge.request("set_device_parameter_display",plan);
    if(observed.verified!==true||observed.stateVersion!==args.expectedStateVersion+1||observed.trackId!==args.trackId||observed.deviceId!==args.deviceId||observed.parameterId!==args.parameterId)throw Error("parameter display readback mismatch; inspect current controls before retrying");
    return observed;
  },preview:{warning:"Changes one exposed continuous control. Native dependencies may change other controls; hidden state, routing and sound quality are not verified."}});
}
