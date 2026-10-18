import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {getPrompt} from "../src/prompts.mjs";

test("Arrangement placement binds source content and native identity before confirmation",async()=>{
  const before={stateVersion:4,trackId:"track-0",clipId:"track-0:clip-0",source:{id:"track-0:clip-0",hasClip:true,lengthBeats:4},beforeArrangement:[],
    placement:{unit:'beats',lengthBeats:4,leadInBeats:0,loopLengthBeats:4,basis:'loop-plus-lead-in'},
    sourceGuard:{identityToken:"source-a",contentSha256:"notes-a"}},writes=[];
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_session_clip_arrangement_source")return structuredClone(before);
    if(method==="list_clips")return {stateVersion:4,trackId:"track-0",clips:[before.source]};
    if(method==="list_arrangement_clips")return {stateVersion:4,trackId:"track-0",clips:before.beforeArrangement};
    if(method==="place_session_clip_in_arrangement"){writes.push(params);return {stateVersion:5};}
    throw Error(method);
  }}});
  const args={trackId:"track-0",clipId:"track-0:clip-0",startBeats:8,expectedStateVersion:4};
  for(const field of ["contentSha256","identityToken"]){
    const plan=await service.call("place_session_clip_in_arrangement",args);
    assert.deepEqual(plan.plan.sourceGuard,before.sourceGuard);
    before.sourceGuard[field]+="-changed";
    await assert.rejects(service.call("place_session_clip_in_arrangement",{...args,dryRun:false,
      confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));
    assert.equal(writes.length,0);
  }
});

function offsetFixture(){
 const before={stateVersion:4,trackId:'track-0',clipId:'track-0:clip-0',source:{hasClip:true,lengthBeats:6},beforeArrangement:[],
  placement:{unit:'beats',lengthBeats:8,leadInBeats:2,loopLengthBeats:6,basis:'loop-plus-lead-in'},
  sourceGuard:{identityToken:'clip',contentSha256:'content'}};
 let writes=0;
 const service=new ToolService({bridge:{async request(method,args){
  if(method==='get_session_clip_arrangement_source')return structuredClone(before);
  if(method==='place_session_clip_in_arrangement'){writes++;return {stateVersion:5,placementVerified:false,error:'partial copy'};}
  throw Error(method);
 }}});
 return {before,service,writes:()=>writes,args:{trackId:'track-0',clipId:'track-0:clip-0',startBeats:16,expectedStateVersion:4}};
}
test('offset Session loop plans the full loop plus lead-in span',async()=>{
 const f=offsetFixture(),p=await f.service.call('place_session_clip_in_arrangement',f.args);
 assert.equal(p.plan.endBeats,24);assert.deepEqual(p.plan.placement,f.before.placement);assert.equal(f.writes(),0);
 const result=await f.service.call('place_session_clip_in_arrangement',{...f.args,dryRun:false,
  confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
 assert.equal(result.observed.placementVerified,false);assert.equal(f.writes(),1);
});
test('lead-in tail overlap refuses before a copy, while adjacent space is allowed',async()=>{
 const f=offsetFixture();f.before.beforeArrangement=[{startBeats:22,endBeats:26}];
 await assert.rejects(f.service.call('place_session_clip_in_arrangement',f.args),/overlap/);assert.equal(f.writes(),0);
 f.before.beforeArrangement=[{startBeats:24,endBeats:26}];
 assert.equal((await f.service.call('place_session_clip_in_arrangement',f.args)).plan.endBeats,24);
});
test('missing or invalid placement ranges require a current bridge before planning',async()=>{
 for(const range of [undefined,{unit:'seconds',lengthBeats:8},{unit:'beats',lengthBeats:0}]){
  const f=offsetFixture();f.before.placement=range;
  await assert.rejects(f.service.call('place_session_clip_in_arrangement',f.args),/placement|bridge/);assert.equal(f.writes(),0);
 }
});
test('placement reserves capacity for its new clip before issuing a plan',async()=>{
 const f=offsetFixture();f.before.beforeArrangement=Array.from({length:4096},(_,i)=>({startBeats:100+i*2,endBeats:101+i*2}));
 await assert.rejects(f.service.call('place_session_clip_in_arrangement',f.args),/capacity|4096/);assert.equal(f.writes(),0);
});

test("Session arrangement workflow validates mode and is shared by MCP retrieval and prompt",async()=>{
  const service=new ToolService({bridge:{request:async()=>{throw Error("retrieval must not call Live");}}});
  for(const mode of [undefined,"collaborative","autonomous"]){
    const args={request:"Arrange the named chords and bass into two sections; preserve Session clips.",...(mode?{mode}:{})};
    const result=await service.call("get_producer_workflow",{workflow:"arrange-session-ideas",arguments:args});
    assert.deepEqual(result.messages,getPrompt("arrange-session-ideas",args).messages);
  }
  await assert.rejects(service.call("get_producer_workflow",{workflow:"arrange-session-ideas",arguments:{request:"Arrange",mode:"overwrite"}}));
});
