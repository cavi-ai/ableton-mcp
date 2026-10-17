import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';
import {getPrompt} from '../src/prompts.mjs';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('multi-selected headers may focus their exact selection owner',async()=>{
 const context={};runInNewContext(await readFile(new URL('../src/live-track-grouping.js',import.meta.url),'utf8'),context);
 const expected=['SessionView.Track[2].TitleBar','SessionView.Track[3].TitleBar'];
 assert.equal(context.groupingRangeMatches(expected.slice().reverse(),expected,'',true),true);
 assert.equal(context.groupingRangeMatches(expected,expected,expected[1],false),true);
 assert.equal(context.groupingRangeMatches(expected,expected,'other-header',false),false);
 assert.equal(context.groupingRangeMatches(expected.slice(0,1),expected,'',true),false);
 assert.equal(context.groupingRangeMatches([...expected,'extra'],expected,'',true),false);
});

const args={trackIds:['track-2','track-3'],expectedStateVersion:3,expectedSetFingerprint:'set'};
function fixture(){let identity='handle',grouped=false,prepares=0,commits=0,cancels=0;
 const bridge={request:async(method,p)=>{if(method==='get_track_grouping_source')return {stateVersion:3,setFingerprint:'set',groupingId:identity,identityToken:identity,filePath:'/sets/Example.als',setName:'Example',targets:args.trackIds.map((trackId,i)=>({trackId,name:'Part '+i,uiPath:'.Track['+(i+2)+']',contentSha256:'content'}))};
 assert.equal(method,'get_track_grouping_status');return {stateVersion:grouped?4:3,groupingId:p.groupingId,status:grouped?'grouped':'unchanged',groupVerified:grouped,inspectionRequired:false,originalOrderPreserved:grouped,membershipVerified:grouped,materialPreserved:true,routingVerified:grouped,controlsPreserved:true,group:grouped?{id:'track-2',isGroup:true}:null,members:args.trackIds.map((sourceTrackId,i)=>({sourceTrackId,trackId:grouped?'track-'+(i+3):sourceTrackId,materialPreserved:true}))};}};
 const host={prepare:async(_s,{beforePrepare})=>{prepares++;await beforePrepare();return {owned:true};},commit:async(_s,_p,{beforeCommit})=>{commits++;await beforeCommit();grouped=true;return {groupRequested:true,popupClosed:true,uiIdle:true};},cancel:async()=>{cancels++;return {cancelled:true};}};
 return {bridge,host,service:new ToolService({bridge,trackGroupingHost:host}),change(){identity='changed';},set grouped(v){grouped=v;},get counts(){return {prepares,commits,cancels};}};
}
async function confirmed(f,p){return f.service.call('group_tracks',{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});}
test('grouping plans preserve UI, execute once and return new native identities',async()=>{
 const f=fixture(),p=await f.service.call('group_tracks',args);assert.equal(f.counts.prepares,0);assert.equal(p.plan.before.groupingId,'handle');const r=await confirmed(f,p);assert.equal(r.groupVerified,true);assert.equal(r.observed.members[0].trackId,'track-3');await assert.rejects(confirmed(f,p));assert.equal(f.counts.commits,1);
});
test('same-version stale targets and wrong Set guards refuse all UI actions',async()=>{
 const f=fixture(),p=await f.service.call('group_tracks',args);f.change();await assert.rejects(confirmed(f,p),/changed/);assert.equal(f.counts.prepares,0);await assert.rejects(f.service.call('group_tracks',{...args,expectedSetFingerprint:'other'}),/Set/);validateToolArguments('group_tracks',args);
});
test('a changed context after preparation cancels only the unchanged owned menu',async()=>{
 const f=fixture(),original=f.host.prepare;f.host.prepare=async(...a)=>{const r=await original(...a);f.change();return r;};const p=await f.service.call('group_tracks',args),r=await confirmed(f,p);assert.equal(r.groupRequested,false);assert.equal(r.groupVerified,false);assert.equal(f.counts.cancels,1);assert.equal(r.dialogCleanup.cancelled,true);
});
test('uncertain command outcomes preserve actual native status and are never replayed or cancelled',async()=>{
 const f=fixture();f.host.commit=async()=>{f.grouped=true;throw Object.assign(Error('reply lost'),{groupRequested:null});};const p=await f.service.call('group_tracks',args),r=await confirmed(f,p);assert.equal(r.groupRequested,null);assert.equal(r.groupVerified,false);assert.equal(r.observed.groupVerified,true);assert.equal(f.counts.cancels,0);assert.equal((await f.service.call('get_track_grouping_status',{groupingId:'handle'})).groupVerified,true);
});
test('incomplete verification cannot claim native grouping success',async()=>{
 for(const corrupt of [r=>delete r.materialPreserved,r=>r.members[0].trackId='track-99',r=>r.members[0].sourceTrackId='track-9',r=>r.group.isGroup=false]){
 const f=fixture(),original=f.bridge.request;f.bridge.request=async(...a)=>{const r=await original(...a);if(a[0]==='get_track_grouping_status'&&r.groupVerified)corrupt(r);return r;};const p=await f.service.call('group_tracks',args),r=await confirmed(f,p);assert.equal(r.groupVerified,false);assert.equal(r.observed.inspectionRequired,true);
 }
});
test('grouping requires exactly the native topology version advance',async()=>{
 for(const stateVersion of [3,5]){
  const f=fixture(),original=f.bridge.request;f.bridge.request=async(...a)=>{const r=await original(...a);if(a[0]==='get_track_grouping_status'&&r.groupVerified)r.stateVersion=stateVersion;return r;};
  const p=await f.service.call('group_tracks',args);assert.equal((await confirmed(f,p)).groupVerified,false);
 }
});
test('a successful truncated receipt cannot satisfy a larger requested grouping',async()=>{
 const f=fixture(),original=f.bridge.request,request={...args,trackIds:['track-2','track-3','track-4']};f.bridge.request=async(...a)=>{const r=await original(...a);if(a[0]==='get_track_grouping_source')r.targets.push({trackId:'track-4',name:'Part 2',uiPath:'.Track[4]',contentSha256:'content'});return r;};const p=await f.service.call('group_tracks',request),r=await f.service.call('group_tracks',{...request,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});assert.equal(r.groupVerified,false);
});
test('grouping and recovery tools are available only in all profile',async()=>{
 const f=fixture(),all=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'}),tools=(await all({id:1,method:'tools/list'})).result.tools;assert.equal(tools.find(t=>t.name==='get_track_grouping_status').annotations.readOnlyHint,true);assert.equal(tools.find(t=>t.name==='group_tracks').annotations.readOnlyHint,false);assert.equal((await core({id:2,method:'tools/call',params:{name:'group_tracks',arguments:args}})).error.code,-32601);
});
test('grouping workflow retains recovery context and refreshes shifted IDs before naming the bus',()=>{
 assert.throws(()=>getPrompt('group-session-tracks'),/required/);const text=getPrompt('group-session-tracks',{request:'Group the two named synth layers as Synth bus'}).messages[0].content.text;
 for(const required of ['Group the two named synth layers as Synth bus','group_tracks','get_track_grouping_status','groupingId','consecutive','rename_session_object','track IDs','hidden'])assert.ok(text.includes(required),required);
});
