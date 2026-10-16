import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";

function fixture() {
  const before={stateVersion:4,identityToken:"scene-native-identity",scene:{id:"scene-0",name:"Idea"},
    tracks:[{id:"track-0",slot:{action:"launch-clip"}},{id:"track-1",slot:{action:"empty-stop"}}]}, writes=[];
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==="get_scene_launch_context")return structuredClone(before);
    if(method==="get_live_state")return {stateVersion:4};
    if(method==="launch_scene"){writes.push(params);return {stateVersion:5,launchRequested:true,playbackVerified:false};}
    throw Error(method);
  }}});
  return {service,before,writes};
}
const args={sceneId:"scene-0",expectedStateVersion:4};
test("scene launch includes the entire row in a single-use confirmation without firing it",async()=>{
  const {service,before,writes}=fixture(),plan=await service.call("launch_scene",args);
  assert.deepEqual(plan.plan.before,before);assert.equal(writes.length,0);
  assert.match(plan.plan.warning,/recording/);assert.match(plan.plan.warning,/stop/);
  const execute={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  const result=await service.call("launch_scene",execute);
  assert.equal(result.observed.launchRequested,true);assert.equal(result.observed.playbackVerified,false);
  assert.deepEqual(writes[0].before,before);
  await assert.rejects(service.call("launch_scene",execute));assert.equal(writes.length,1);
});
test("changed scene impact or identity invalidates confirmation even at the same state version",async()=>{
  for(const change of ["stop","scene","identity"]){
    const {service,before,writes}=fixture(),plan=await service.call("launch_scene",args);
    if(change==="stop")before.tracks[1].slot.action="empty-no-stop";
    if(change==="scene")before.scene.name="New idea";
    if(change==="identity")before.identityToken="replacement";
    await assert.rejects(service.call("launch_scene",{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash}));
    assert.equal(writes.length,0);
  }
});
test("scene launch rejects malformed identities and legato values before reading Live",async()=>{
  const {service}=fixture();
  for(const invalid of [{sceneId:"scene--1"},{sceneId:"scene-01"},{sceneId:"other"},{forceLegato:"yes"}])
    await assert.rejects(service.call("launch_scene",{...args,...invalid}));
});
test("unavailable native scene quantization is reported before attempting to normalize choices",async()=>{
  const service=new ToolService({bridge:{request:async()=>({stateVersion:4,scenes:[{id:"scene-0",launchQuantization:{supported:false}}]})}});
  await assert.rejects(service.call("set_scene_launch_quantization",{...args,launchQuantization:"none"}),/scene launch quantization is unavailable/);
});
