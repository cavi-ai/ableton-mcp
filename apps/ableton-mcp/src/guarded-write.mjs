import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';

// Any refusal here happens before the Live write, so it is tagged not_executed.
export function consumeConfirmation(confirmations,plan,args,mismatch){
  try{
    requestSignal()?.throwIfAborted();
    const hash=hashPlan(plan);
    if(args.planHash!==hash)throw Error(mismatch);
    return confirmations.consume(args.confirmationToken,hash);
  }catch(error){
    error.outcome='not_executed';
    error.code||='CONFIRMATION_REJECTED';
    throw error;
  }
}

// Returns the dry-run reply, or undefined once the confirmation is consumed.
export function beginGuardedWrite(confirmations,plan,args,{mismatch,preview}={}){
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),...preview};
  consumeConfirmation(confirmations,plan,args,mismatch);
}

export async function guardedWrite(confirmations,plan,args,{mismatch,preview,execute}){
  const reply=beginGuardedWrite(confirmations,plan,args,{mismatch,preview});
  if(reply)return reply;
  return {dryRun:false,requested:plan,observed:await execute(),timestamp:new Date().toISOString()};
}
