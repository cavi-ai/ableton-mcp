import {hashPlan} from "./confirmation-store.mjs";

export async function beatRepeatFill(bridge,confirmations,name,args){
  if(name==="get_beat_repeat_fill")return bridge.request(name,args);
  if(!Number.isInteger(args.expectedStateVersion))throw Error("expectedStateVersion is required");
  const starting=name==="perform_beat_repeat_fill";
  if(starting&&(!Number.isFinite(args.durationSeconds)||args.durationSeconds<.25||args.durationSeconds>8))
    throw Error("fill duration must be between 0.25 and 8 seconds");
  if(!starting&&(typeof args.fillId!=="string"||!args.fillId))throw Error("fillId is required");
  if(!starting&&args.cancel!==undefined&&typeof args.cancel!=="boolean")throw Error("cancel must be boolean");
  const target=starting?{trackId:args.trackId,deviceId:args.deviceId}:{fillId:args.fillId};
  const before=await bridge.request(starting?"get_beat_repeat_fill_source":"get_beat_repeat_fill",target);
  if(before.stateVersion!==args.expectedStateVersion||
    (starting?(before.trackId!==args.trackId||before.deviceId!==args.deviceId):before.fillId!==args.fillId))
    throw Error("fill identity or state changed; re-read before retrying");
  const plan={method:name,...target,expectedStateVersion:args.expectedStateVersion,
    ...(starting?{durationSeconds:args.durationSeconds}:{cancel:args.cancel??false}),before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:starting
    ?"Sets Repeat On now and requests Off after a wall-clock duration on Live display ticks, even without this client. Not beat-scheduled or a hard real-time bound. Only Repeat is owned, not bypass or automatic Chance/Gate repeats. Manual Repeat changes relinquish ownership. Inspect retained handles after uncertainty; never replay a start blindly."
    :"Releases the runtime handle. Cancel explicitly attempts early Repeat Off only while ownership remains valid; manual edits are preserved. Terminal cleanup failures remain explicit and releasing a handle does not fix them."};
  if(args.planHash!==hashPlan(plan))throw Error("confirmation plan hash mismatch: fill context changed");
  confirmations.consume(args.confirmationToken,args.planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request(name,plan)};
}
