import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
function fixture(){
 const source={stateVersion:4,trackId:'track-0',identityToken:'native-a',supported:true,takePromotionSupported:false,
  filePath:'/set.als',setName:'set',scriptDirectory:'/app/Contents/App-Resources/MIDI Remote Scripts/CaviMcpBridge',
  uiTrackPath:'ArrangementView.Track[0]',uiAncestors:[],
  track:{name:'Vocal',frozen:false,armed:false,firedSlotIndex:-1},recording:{isPlaying:true,arrangement:false,session:false},
  lanes:[{id:'track-0:take-lane-0',name:'Lane',clips:[]},{id:'track-0:take-lane-1',name:'Lane',clips:[]}],arrangement:[],selected:null};
 const ui={pid:7,windowId:9,windowTitle:'set',documentPath:'/set.als',mode:'session',visible:false,lanes:[]},calls=[];
 const host={async inspect(){return structuredClone(ui);},async show(before,expected,{beforeAction}){
  await beforeAction();calls.push('show');Object.assign(ui,{mode:'arrangement',visible:true,lanes:source.lanes.map((l,index)=>({index,name:l.name,audition:false}))});return structuredClone(ui);
 },async select(before,expected,index,{beforeAction}){
  await beforeAction();calls.push(index);ui.lanes.forEach(l=>l.audition=l.index===index);return structuredClone(ui);
 }};
 const service=new ToolService({bridge:{async request(method){assert.equal(method,'get_take_lane_context');return structuredClone(source);}},takeLaneAuditionHost:host});
 return {source,ui,calls,host,service,args:{trackId:'track-0',expectedStateVersion:4}};
}
const execute=(args,plan)=>({...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
test('native UI guards refuse unknown flags and missing or different saved documents',async()=>{
 const guards=vm.runInNewContext((await readFile(new URL('../src/live-take-lane-audition.js',import.meta.url),'utf8'))+';({takeLaneFlag,requireTakeDocument})');
 for(const value of [null,undefined,'', '0','1',2,{},[]])assert.throws(()=>guards.takeLaneFlag(value),/unknown/);
 for(const value of [0,false])assert.equal(guards.takeLaneFlag(value),false);
 for(const value of [1,true])assert.equal(guards.takeLaneFlag(value),true);
 assert.equal(guards.requireTakeDocument('/one/set.als','/one/set.als'),'/one/set.als');
 for(const paths of [[null,'/one/set.als'],['/one/set.als',null],['/one/set.als','/two/set.als'],['','']])assert.throws(()=>guards.requireTakeDocument(...paths));
});
async function show(f){const p=await f.service.call('show_take_lanes',f.args);return f.service.call('show_take_lanes',execute(f.args,p));}
test('take visibility is separately confirmed; lane audition switches exclusivity and returns to the comp',async()=>{
 const f=fixture(),read=await f.service.call('get_take_lane_audition_context',{trackId:'track-0'});assert.equal(read.audition.visible,false);assert.deepEqual(f.calls,[]);
 const p=await f.service.call('show_take_lanes',f.args);assert.deepEqual(f.calls,[]);assert.equal((await f.service.call('show_take_lanes',execute(f.args,p))).selectionVerified,true);
 for(const laneId of ['track-0:take-lane-0','track-0:take-lane-1',null]){
  const args={...f.args,laneId},plan=await f.service.call('select_take_lane_audition',args),result=await f.service.call('select_take_lane_audition',execute(args,plan));
  assert.equal(result.selectionVerified,true);assert.equal(result.selectedLaneId,laneId);assert.equal(result.materialPreservationVerified,false);
  await assert.rejects(f.service.call('select_take_lane_audition',execute(args,plan)));
 }
 assert.deepEqual(f.calls,['show',0,1,null]);
});
test('recording, frozen/armed targets, folded groups, hidden lanes and malformed IDs refuse without actions',async()=>{
 for(const change of [f=>f.source.track.armed=true,f=>f.source.track.frozen=true,f=>f.source.recording.arrangement=true,
  f=>f.source.recording.session=true,f=>f.source.uiAncestors=[{folded:true}],f=>f.source.supported=false]){
  const f=fixture();change(f);await assert.rejects(f.service.call('show_take_lanes',f.args));assert.deepEqual(f.calls,[]);
 }
 const f=fixture();await assert.rejects(f.service.call('select_take_lane_audition',{...f.args,laneId:null}),/visible/);
 await show(f);for(const laneId of ['track-1:take-lane-0','track-0:take-lane-00','track-0:take-lane-2',undefined])
  await assert.rejects(f.service.call('select_take_lane_audition',{...f.args,laneId}));
 assert.deepEqual(f.calls,['show']);
});
test('changed native context or visible audition flags invalidate confirmation',async()=>{
 for(const change of [f=>f.source.identityToken='replacement',f=>f.ui.lanes[1].audition=true]){
  const f=fixture();await show(f);const args={...f.args,laneId:'track-0:take-lane-0'},p=await f.service.call('select_take_lane_audition',args);change(f);
  await assert.rejects(f.service.call('select_take_lane_audition',execute(args,p)));assert.deepEqual(f.calls,['show']);
 }
});
test('post-action source changes report unverified selection and preserve the observed UI state',async()=>{
 const f=fixture();await show(f);const select=f.host.select;f.host.select=async(...args)=>{const result=await select(...args);f.source.identityToken='replacement';return result;};
 const args={...f.args,laneId:'track-0:take-lane-0'},p=await f.service.call('select_take_lane_audition',args),result=await f.service.call('select_take_lane_audition',execute(args,p));
 assert.equal(result.selectionVerified,false);assert.equal(result.contextUnchanged,false);assert.equal(f.ui.lanes[0].audition,true);assert.equal(f.calls.length,2);
});
test('audition controls are available in all profile with read-only context and a producer workflow',async()=>{
 const f=fixture(),router=createRouter(f.service),tools=(await router({id:1,method:'tools/list'})).result.tools;
 assert.equal(tools.find(t=>t.name==='get_take_lane_audition_context').annotations.readOnlyHint,true);
 assert.equal(tools.find(t=>t.name==='select_take_lane_audition').annotations.readOnlyHint,false);
 assert.ok((await f.service.call('get_producer_workflow',{workflow:'audition-recorded-takes',arguments:{request:'Compare two takes and return to the comp'}})).messages.length);
});
