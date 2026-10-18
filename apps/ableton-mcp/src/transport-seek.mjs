import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function seekTransport(bridge,confirmations,args,changes){
 const before=await bridge.request('get_transport_seek_context',{});
 assertExpectedState(args,before);
 if(typeof before.identityToken!=='string'||!before.identityToken||typeof before.transport?.isPlaying!=='boolean')throw Error('updated native transport seek identity required');
 const plan={method:'set_transport_recording_context',expectedStateVersion:args.expectedStateVersion,before,changes,
  warning:'Absolute seek; a moving playing position is not reserved or verified. Active recording must be stopped separately. Recording commands can start playback and capture content. Partial writes are not rolled back or replayed.'};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
 if(args.planHash!==hashPlan(plan))throw Error('transport seek confirmation context changed');
 confirmations.consume(args.confirmationToken,args.planHash);
 const receipt=await bridge.request(plan.method,plan);
 return {dryRun:false,requested:plan,observed:receipt.observed,seekReceipt:receipt,verification:receipt.verification};
}
