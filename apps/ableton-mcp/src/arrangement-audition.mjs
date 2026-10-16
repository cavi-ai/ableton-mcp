import {assertExpectedState} from "./bridge-protocol.mjs";
import {assertArrangementRange} from "./arrangement-section.mjs";
import {hashPlan} from "./confirmation-store.mjs";

export async function auditionArrangementPassage(bridge,confirmations,args){
  assertArrangementRange(args);
  if(!Array.isArray(args.trackIds)||args.trackIds.length<1||args.trackIds.length>64||
    new Set(args.trackIds).size!==args.trackIds.length||args.trackIds.some(id=>typeof id!=="string"||!/^track-(0|[1-9][0-9]*)$/.test(id)))
    throw new Error("audition requires 1-64 unique ordinary track IDs");
  if(!Number.isInteger(args.expectedStateVersion))throw new Error("expectedStateVersion is required");
  const request={trackIds:args.trackIds,startBeats:args.startBeats,endBeats:args.endBeats};
  const before=await bridge.request("get_arrangement_audition_source",request);
  assertExpectedState(args,before);
  const plan={method:"audition_arrangement_passage",...request,expectedStateVersion:args.expectedStateVersion,before};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:
    "Starts global playback in a changed Arrangement loop and returns only the named ordinary tracks from Session override. Other tracks may sound. Playback continues until stopped; earlier Session phase is not restored."};
  const planHash=hashPlan(plan);
  if(args.planHash!==planHash)throw new Error("confirmation plan hash mismatch: audition context changed");
  confirmations.consume(args.confirmationToken,planHash);
  return {dryRun:false,requested:plan,observed:await bridge.request("audition_arrangement_passage",plan)};
}
