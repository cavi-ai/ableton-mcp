import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';

const args={groupTrackId:'track-2',expectedStateVersion:3,expectedSetFingerprint:'set'};
function fixture(){
 let identity='handle',removed=false,devices=false,selected='track-2',prepares=0,commands=0,cancels=0;
 const source={stateVersion:3,setFingerprint:'set',operation:'ungroup',filePath:'/sets/Example.als',setName:'Example',groupTrackId:'track-2',
  targets:[{trackId:'track-2',name:'Bus',visibleIndex:1,isGroup:true}],visibleTracks:[{trackId:'track-0',name:'Piano',isGroup:false},{trackId:'track-2',name:'Bus',isGroup:true}],
  members:[{sourceTrackId:'track-3'},{sourceTrackId:'track-4'}],removedGroup:{track:{name:'Bus'},devices:[]}};
 const bridge={request:async(method,p)=>{
  if(method==='get_track_ungrouping_source'){
   if(removed)throw Error('Group absent');return {...structuredClone(source),identityToken:identity,ungroupingId:identity,hasGroupDevices:devices,removedGroup:{...source.removedGroup,devices:devices?[{name:'EQ'}]:[]}};
  }
  if(method==='get_selection_context')return {stateVersion:3,setFingerprint:'set',selectedTrack:{id:selected}};
  assert.equal(method,'get_track_ungrouping_status');return {stateVersion:removed?4:3,ungroupingId:p.ungroupingId,removedGroupId:'track-2',expectedMemberCount:2,
   status:removed?'ungrouped':'unchanged',ungroupVerified:removed,groupRemoved:removed,originalOrderPreserved:removed,membershipVerified:removed,
   materialPreserved:true,routingVerified:removed,controlsPreserved:true,inspectionRequired:false,
   members:source.members.map(m=>({...m,trackId:removed?'track-'+(Number(m.sourceTrackId.slice(6))-1):m.sourceTrackId,materialPreserved:true,groupTrackId:null}))};
 }};
 const host={prepare:async(_s,{beforePrepare})=>{await beforePrepare();prepares++;return {owned:true};},commit:async(_s,_p,{beforeCommit})=>{await beforeCommit();commands++;removed=true;return {groupRequested:true,popupClosed:true,uiIdle:true};},cancel:async()=>{cancels++;return {cancelled:true};}};
 return {bridge,host,service:new ToolService({bridge,trackGroupingHost:host}),change(){identity='changed';},set devices(v){devices=v;},set selected(v){selected=v;},set removed(v){removed=v;},get counts(){return {prepares,commands,cancels};}};
}
async function execute(f,p,input=args){return f.service.call('ungroup_tracks',{...input,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});}

test('ungrouping plans are inert, execute once and retain original member identities',async()=>{
 const f=fixture(),p=await f.service.call('ungroup_tracks',args);assert.equal(f.counts.prepares,0);assert.equal(p.plan.before.ungroupingId,'handle');
 const result=await execute(f,p);assert.equal(result.ungroupRequested,true);assert.equal(result.ungroupVerified,true);assert.equal(result.observed.members[0].trackId,'track-2');
 await assert.rejects(execute(f,p));assert.equal(f.counts.commands,1);
});
test('Group device removal requires a separately bound content permission',async()=>{
 const f=fixture();f.devices=true;const p=await f.service.call('ungroup_tracks',args);assert.equal(p.plan.before.hasGroupDevices,true);
 await assert.rejects(execute(f,p),/allowContent/);await assert.rejects(execute(f,p,{...args,allowContent:true}),/changed|hash/);assert.equal(f.counts.prepares,0);
 const input={...args,allowContent:true},allowed=await f.service.call('ungroup_tracks',input);assert.equal((await execute(f,allowed,input)).ungroupVerified,true);
});
test('same-version stale context and wrong native selection stop before Ungroup',async()=>{
 const f=fixture(),p=await f.service.call('ungroup_tracks',args);f.change();await assert.rejects(execute(f,p),/changed/);assert.equal(f.counts.prepares,0);
 const fresh=await f.service.call('ungroup_tracks',args);f.selected='track-9';const result=await execute(f,fresh);assert.equal(result.ungroupRequested,false);assert.equal(f.counts.commands,0);assert.equal(f.counts.cancels,1);
});
test('uncertain Ungroup replies preserve observed state without replay or automatic regrouping',async()=>{
 const f=fixture();f.host.commit=async()=>{f.removed=true;throw Object.assign(Error('reply lost'),{groupRequested:null});};
 const p=await f.service.call('ungroup_tracks',args),r=await execute(f,p);assert.equal(r.ungroupRequested,null);assert.equal(r.ungroupVerified,false);assert.equal(r.observed.ungroupVerified,true);assert.equal(f.counts.cancels,0);
 assert.equal((await f.service.call('get_track_ungrouping_status',{ungroupingId:'handle'})).ungroupVerified,true);
});
test('incomplete member receipts, wrong identities or version advances never verify',async()=>{
 for(const corrupt of [r=>r.members.pop(),r=>r.members[0].sourceTrackId='track-8',r=>delete r.materialPreserved,r=>r.groupRemoved=false,r=>r.stateVersion=3,r=>r.stateVersion=5]){
  const f=fixture(),request=f.bridge.request;f.bridge.request=async(...a)=>{const r=await request(...a);if(a[0]==='get_track_ungrouping_status'&&r.ungroupVerified)corrupt(r);return r;};
  const p=await f.service.call('ungroup_tracks',args);assert.equal((await execute(f,p)).ungroupVerified,false);
 }
});
test('missing device-loss evidence or inconsistent visible target data refuses all UI actions',async()=>{
 for(const corrupt of [r=>delete r.hasGroupDevices,r=>delete r.removedGroup.devices,r=>r.targets[0].visibleIndex=99,r=>r.visibleTracks[1].trackId='track-9']){
  const f=fixture(),request=f.bridge.request;f.bridge.request=async(...a)=>{const r=await request(...a);if(a[0]==='get_track_ungrouping_source')corrupt(r);return r;};
  await assert.rejects(f.service.call('ungroup_tracks',args),/context/);assert.equal(f.counts.prepares,0);
 }
});
test('ungrouping stays outside core and carries a destructive annotation',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'}),listed=(await all({id:1,method:'tools/list'})).result.tools;
 assert.equal(listed.find(t=>t.name==='ungroup_tracks').annotations.destructiveHint,true);
 assert.equal(listed.find(t=>t.name==='get_track_ungrouping_status').annotations.readOnlyHint,true);
 assert.equal((await core({id:2,method:'tools/call',params:{name:'ungroup_tracks',arguments:args}})).error.code,-32601);
});
test('ungrouping workflow discloses removed processing and refreshes shifted identities',()=>{
 const text=getPrompt('ungroup-session-tracks',{request:'Ungroup the Synth bus'}).messages[0].content.text;
 for(const value of ['Ungroup the Synth bus','ungroup_tracks','get_track_ungrouping_status','allowContent','ungroupingId','routing','track IDs','hidden'])assert.ok(text.includes(value),value);
});
test('Group header resolution binds the entire visible native order and literal label variants',async()=>{
 const scope={};runInNewContext(await readFile(new URL('../src/live-track-grouping.js',import.meta.url),'utf8'),scope);
 const visible=[{trackId:'track-0',name:'Piano',isGroup:false},{trackId:'track-2',name:'3-Group',isGroup:true}];
 const rows=[{id:'SessionView.Track[0].TitleBar',name:'Piano',isGroup:false},{id:'SessionView.GroupTrack[1].GroupTrack.TitleBar',name:'Group',isGroup:true}],target={...visible[1],visibleIndex:1};
 assert.equal(scope.ungroupHeaderId(rows,visible,target),rows[1].id);
 assert.equal(scope.ungroupHeaderId(rows.slice().reverse(),visible,target),null);
 assert.equal(scope.ungroupHeaderId([...rows,rows[1]],visible,target),null);
 assert.equal(scope.ungroupHeaderId(rows,visible,{...target,trackId:'track-3'}),null);
 assert.equal(scope.ungroupHeaderId([{...rows[0],name:'Changed'},rows[1]],visible,target),null);
 assert.equal(scope.ungroupHeaderId([rows[0],{...rows[1],name:'2-Group'}],visible,target),null);
});
