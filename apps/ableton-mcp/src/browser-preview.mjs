import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';

export async function browserPreview(bridge,confirmations,name,args){
 const target={};
 if(args.root!==undefined||args.path!==undefined){
  if(typeof args.root!=='string'||!Array.isArray(args.path)||args.path.length<1||args.path.length>32||
   args.path.some(part=>typeof part!=='string'||!part||part.length>256))throw Error('exact browser root and nonempty path required');
  Object.assign(target,{root:args.root,path:args.path});
 }
 if(name==='get_browser_preview_context')return bridge.request(name,target);
 if(!['start','stop'].includes(args.action)||!Number.isInteger(args.expectedStateVersion))throw Error('preview action and expectedStateVersion required');
 if((args.action==='start')!==!!target.root)throw Error('start requires an item; global stop excludes item scope');
 const before=await bridge.request('get_browser_preview_context',target);assertExpectedState(args,before);
 if(typeof before.identityToken!=='string'||!before.identityToken||before.stopSupported!==true)throw Error('updated native preview context with stop support required');
 if(args.action==='start'){
  if(before.root!==target.root||JSON.stringify(before.path)!==JSON.stringify(target.path)||before.previewSupported!==true||!before.item||before.item.folder!==false)
   throw Error('exact non-folder browser preview target is unavailable');
  if(!before.transport||['arrangementRecord','sessionRecord','countingIn'].some(key=>before.transport[key]!==false))
   throw Error('resolve recording and count-in before previewing');
 }
 const plan={method:'set_browser_preview',action:args.action,...target,expectedStateVersion:args.expectedStateVersion,before};
 if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan),warning:
  'Affects Live’s global browser preview, including a user-started preview. Start can replace it; stop is global. No preview ownership, duration, active-state or audible-output verification. Does not load the item. Do not replay an uncertain command or stop a later manual preview automatically.'};
 const hash=hashPlan(plan);if(args.planHash!==hash)throw Error('confirmation plan hash mismatch: browser preview context changed');
 confirmations.consume(args.confirmationToken,hash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
