import {assertExpectedState} from "./bridge-protocol.mjs";
import {hashPlan} from "./confirmation-store.mjs";

export async function setTrackVolumeDb(bridge,confirmations,args){
  if(typeof args.trackId!=="string"||!/^(master|(track|return)-(0|[1-9][0-9]*))$/.test(args.trackId))throw new Error("canonical track, Return or master ID required");
  if(typeof args.volumeDb!=="number"||!Number.isFinite(args.volumeDb))throw new Error("volumeDb must be finite");
  if(!Number.isInteger(args.expectedStateVersion))throw new Error("expectedStateVersion required");
  const request={trackId:args.trackId,volumeDb:args.volumeDb};
  const before=await bridge.request("get_track_volume_edit_context",request);
  assertExpectedState(args,before);
  if(typeof before.identityToken!=="string"||!before.target||!Number.isFinite(before.target.value))throw new Error("updated bridge fader context required");
  const plan={method:"set_track_volume_db",...request,expectedStateVersion:args.expectedStateVersion,before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),
    ...(args.trackId==='master'?{warning:'This Main fader changes the level of the entire mix routed through Main.'}:
      args.trackId.startsWith('return-')?{warning:'This Return fader changes the level of all audio routed through this Return, including other sends.'}:
      before.isGroup?{warning:"This Group fader changes the level of its routed descendants."}:{})};
  const hash=hashPlan(plan);
  if(args.planHash!==hash)throw new Error("confirmation plan hash mismatch: track fader context changed");
  confirmations.consume(args.confirmationToken,hash);
  return {dryRun:false,requested:plan,observed:await bridge.request("set_track_volume_db",plan)};
}
