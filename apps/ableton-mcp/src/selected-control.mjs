import {assertExpectedState} from './bridge-protocol.mjs';
import {guardedWrite} from './guarded-write.mjs';

export async function selectedControl(bridge,confirmations,name,args){
 if(name==='get_selected_parameter_context')return bridge.request(name,{});
 if(typeof args.expectedSelectionToken!=='string'||!args.expectedSelectionToken||args.expectedSelectionToken.length>128||
  (args.value!==undefined)===(args.targetDisplay!==undefined)||args.value!==undefined&&!Number.isFinite(args.value)||
  args.targetDisplay!==undefined&&(typeof args.targetDisplay!=='string'||!args.targetDisplay))throw Error('selection token and exactly one finite value or targetDisplay required');
 const target={expectedSelectionToken:args.expectedSelectionToken,...(args.value!==undefined?{value:args.value}:{targetDisplay:args.targetDisplay})};
 const before=await bridge.request('get_selected_parameter_edit_context',target),selection=before.selection;
 assertExpectedState(args,selection);
 if(selection.status!=='selected'||!selection.target||selection.selectionToken!==args.expectedSelectionToken||!Number.isFinite(before.target?.value))
  throw Error('current selected control or resolved target is unavailable or changed');
 const plan={method:'set_selected_parameter',...target,expectedStateVersion:args.expectedStateVersion,before};
 return guardedWrite(confirmations,plan,args,{mismatch:'confirmation plan hash mismatch: selected control changed',execute:()=>bridge.request(plan.method,plan),preview:{warning:
  'Changes only the exact selected control while preserving focus and playback. Active or unknown automation refuses; manual takeover requires separate intent. Partial native work remains without rollback or replay. Re-read selection for further edits; no audible outcome is inferred.'}});
}
