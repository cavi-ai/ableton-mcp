import {assertExpectedState} from "./bridge-protocol.mjs";
import {guardedWrite} from "./guarded-write.mjs";

export async function setTrackSendDb(bridge,confirmations,args){
  if(typeof args.trackId!=="string"||!/^track-(0|[1-9][0-9]*)$/.test(args.trackId))throw Error("canonical trackId required");
  if(typeof args.sendId!=="string"||!/^send-(0|[1-9][0-9]*)$/.test(args.sendId))throw Error("canonical sendId required");
  if(args.returnTrackId!==`return-${args.sendId.slice(5)}`)throw Error("sendId and returnTrackId must identify the same Return");
  if(args.sendDb!=="-inf"&&(typeof args.sendDb!=="number"||!Number.isFinite(args.sendDb)))throw Error("sendDb must be finite or the explicit -inf target");
  if(!Number.isInteger(args.expectedStateVersion))throw Error("expectedStateVersion required");
  const request={trackId:args.trackId,sendId:args.sendId,returnTrackId:args.returnTrackId,sendDb:args.sendDb};
  const before=await bridge.request("get_track_send_edit_context",request);
  assertExpectedState(args,before);
  if(typeof before.identityToken!=="string"||before.sendId!==args.sendId||before.returnTrackId!==args.returnTrackId||!Number.isFinite(before.target?.value))throw Error("updated bridge send context required");
  const plan={method:"set_track_send_db",...request,expectedStateVersion:args.expectedStateVersion,before};
  return guardedWrite(confirmations,plan,args,{mismatch:"confirmation plan hash mismatch: track send context changed",execute:()=>bridge.request("set_track_send_db",plan),preview:{
    warning:`Changes one ${before.isGroup?"Group":"track"} feed to the named Return. Return processing, routing and send pre/post settings are not changed or verified.`}});
}
