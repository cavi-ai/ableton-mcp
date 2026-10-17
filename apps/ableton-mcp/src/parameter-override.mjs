import {assertExpectedState} from './bridge-protocol.mjs';
import {hashPlan} from './confirmation-store.mjs';
import {parameterAutomationTarget,assertAutomationControlReady} from './parameter-automation.mjs';

export async function overrideParameterAutomation(bridge,confirmations,args){
 const selector=parameterAutomationTarget(args);
 if(!selector.parameterId||!Number.isInteger(args.expectedStateVersion))throw Error('parameterId and expectedStateVersion required');
 const hasValue=args.value!==undefined,hasDisplay=args.targetDisplay!==undefined;
 if(hasValue===hasDisplay)throw Error('provide exactly one finite native value or targetDisplay');
 if(hasValue&&(typeof args.value!=='number'||!Number.isFinite(args.value)))throw Error('value must be finite');
 if(hasDisplay&&(typeof args.targetDisplay!=='string'||!args.targetDisplay.trim()||args.targetDisplay.length>96))throw Error('finite native unit targetDisplay required');
 const request={...selector,...(hasValue?{value:args.value}:{targetDisplay:args.targetDisplay})};
 const source=await bridge.request('get_parameter_override_context',request),{sampledControl,...before}=source;
 assertExpectedState(args,before);assertAutomationControlReady(before,selector,{allowActive:true});
 const p=before.controls[0],active=p.automationState.value===1;
 if(!sampledControl||sampledControl.id!==selector.parameterId||typeof before.target?.value!=='number'||!Number.isFinite(before.target.value)||
  before.valuePolicy!==(active?'advancingAutomation':'manualValueBound')||
  active&&(Object.hasOwn(p,'value')||Object.hasOwn(p,'displayValue'))||!active&&!Number.isFinite(p.value)||
  hasDisplay&&!Number.isFinite(before.target.quantity?.value))throw Error('updated native manual-override context required');
 const plan={method:'override_parameter_automation',...request,expectedStateVersion:args.expectedStateVersion,before};
 const stage=before.ownerType==='master'?'Main affects the routed mix. ':before.ownerType==='return'?'Return controls affect shared routed material. ':before.ownerType==='group'?'A Group affects its routed descendants. ':'';
 if(args.dryRun!==false)return {dryRun:true,plan,sampledControl,confirmation:confirmations.issue(plan),warning:stage+
  'Explicitly overrides one automated control at the resolved absolute value. Active automation values may keep moving before confirmation; existing manual values are bound. This may change routed or mapped material immediately. The envelope is retained. One value write, followed by bounded readback; partial work remains without rollback or replay. This does not establish audible behavior or an exclusive control lease. Resuming automation is a separate explicit action.'};
 const hash=hashPlan(plan);if(args.planHash!==hash)throw Error('confirmation plan hash mismatch: automation control or manual context changed');
 confirmations.consume(args.confirmationToken,hash);
 return {dryRun:false,requested:plan,observed:await bridge.request(plan.method,plan)};
}
