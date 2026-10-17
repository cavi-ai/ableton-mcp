import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {getProducerWorkflow} from "../src/prompts.mjs";
import {getProducerChainBlueprint} from "../src/producer-chain-knowledge.mjs";

function fixture() {
  const tracks = [
    {id:"track-0",name:"Layers",type:"audio",isGroup:false,armed:false},
    ...["Sub","Body","Texture"].map((name,i)=>({id:`track-${i+1}`,name,type:"midi",isGroup:false,armed:false}))
  ];
  const dev=(id,className)=>({id,className,name:className,type:className==="Operator"||className==="Wavetable"||className==="Drift"?"instrument":"audio_effect",parameters:[]});
  const snapshots=Object.fromEntries(tracks.map((track,i)=>[track.id,{stateVersion:5,trackId:track.id,track,
    mixer:{mute:false,solo:false,sends:[]},routing:{input:{type:{id:"No Input",name:"No Input"},availableTypes:[{id:"No Input",name:"No Input"}]},
      monitoring:{value:i===0?0:2,name:i===0?"in":"off"},
      output:{type:{id:i===0?"Main":"Layers",name:i===0?"Main":"Layers"},channel:{id:i===0?"":"Track In",name:i===0?"":"Track In"},
        availableTypes:[{id:"Main",name:"Main"},{id:"Layers",name:"Layers"}],availableChannels:[{id:"Track In",name:"Track In"}]}},
    devices:i===0?[dev("fx-0","Utility"),dev("fx-1","Eq8"),dev("fx-2","Compressor")]:[dev(`synth-${i}`,[null,"Operator","Wavetable","Drift"][i])]}]));
  const calls=[];let reads=0,change;
  const service=new ToolService({bridge:{request:async(method,args)=>{
    calls.push(method);
    if(method==="list_tracks")return structuredClone({stateVersion:5,tracks});
    if(method==="get_track_state_snapshot"){
      if(++reads===5)change?.();
      return structuredClone(snapshots[args.trackId]);
    }
    throw Error(method);
  }}});
  return {service,tracks,snapshots,calls,setChange:fn=>change=fn,args:{target:"layered-bass-system",busTrackId:"track-0",busKind:"audio",
    children:[{role:"sub",trackId:"track-1"},{role:"body",trackId:"track-2"},{role:"texture",trackId:"track-3"}]}};
}

test("audio bus inspection verifies exact routing and instruments without requiring a Group",async()=>{
  const f=fixture(),result=await f.service.call("inspect_producer_bus",f.args);
  assert.equal(result.busKind,"audio");assert.equal(result.matchesBlueprint,true);
  assert.equal(result.consistency,"matching_two_pass_reads");
  assert.ok(result.children.every(c=>c.routed&&c.sourceMatches));
  assert.equal(f.calls.filter(m=>m==="get_track_state_snapshot").length,8);
  assert.ok(f.calls.every(m=>["list_tracks","get_track_state_snapshot"].includes(m)));
});

test("audio bus inspection exposes missing input, monitoring, output and child routes",async()=>{
  for(const edit of [f=>f.snapshots["track-0"].routing.monitoring={value:2,name:"off"},
    f=>f.snapshots["track-0"].routing.input.type={id:"Ext. In",name:"Ext. In"},
    f=>f.snapshots["track-0"].routing.output.type={id:"track-2",name:"Body"},
    f=>f.snapshots["track-1"].routing.output.channel={id:"Post FX",name:"Post FX"},
    f=>f.snapshots["track-1"].routing.output.type={id:"Main",name:"Main"},
    f=>f.snapshots["track-2"].devices[0].className="UnknownInstrument"]){
    const f=fixture();edit(f);assert.equal((await f.service.call("inspect_producer_bus",f.args)).matchesBlueprint,false);
  }
});

test("audio bus inspection refuses ambiguous names, owner aliases and stale native observations",async()=>{
  const duplicate=fixture();duplicate.tracks[1].name="Layers";
  assert.equal((await duplicate.service.call("inspect_producer_bus",duplicate.args)).matchesBlueprint,false);
  const self=fixture();self.args.children[0].trackId="track-0";
  await assert.rejects(self.service.call("inspect_producer_bus",self.args),/distinct|bus itself/);
  const replaced=fixture();replaced.snapshots["track-1"].trackId="track-9";
  await assert.rejects(replaced.service.call("inspect_producer_bus",replaced.args),/identity|observation/);
  const manual=fixture();manual.setChange(()=>manual.snapshots["track-0"].routing.monitoring={value:2,name:"off"});
  await assert.rejects(manual.service.call("inspect_producer_bus",manual.args),/changed/);
});

test("ID-shaped routing labels cannot stand in for the bus target",async()=>{
  const f=fixture();f.tracks[1].name="track-0";
  for(const id of ["track-1","track-2","track-3"]){
    const output=f.snapshots[id].routing.output;
    output.type={id:"track-0",name:"track-0"};
    output.availableTypes.push({id:"track-0",name:"track-0"});
  }
  const result=await f.service.call("inspect_producer_bus",f.args);
  assert.equal(result.matchesBlueprint,false);assert.ok(result.children.every(c=>!c.routed));
});

test("ambiguous or inconsistent input, Main and Track In catalog labels never match",async()=>{
  for(const edit of [f=>f.snapshots["track-0"].routing.input.availableTypes.push({id:"other",name:"No Input"}),
    f=>f.snapshots["track-0"].routing.output.availableTypes.push({id:"other",name:"Main"}),
    f=>f.snapshots["track-1"].routing.output.availableChannels.push({id:"other",name:"Track In"}),
    f=>f.snapshots["track-1"].routing.output.channel.name="Post FX"]){
    const f=fixture();edit(f);assert.equal((await f.service.call("inspect_producer_bus",f.args)).matchesBlueprint,false);
  }
});

test("audio bus contract is reachable through MCP and validates kind before Live",async()=>{
  const f=fixture(),route=createRouter(f.service);
  const result=await route({id:1,method:"tools/call",params:{name:"inspect_producer_bus",arguments:f.args}});
  assert.equal(result.result.structuredContent.matchesBlueprint,true);
  const count=f.calls.length;
  const invalid=await route({id:2,method:"tools/call",params:{name:"inspect_producer_bus",arguments:{...f.args,busKind:"return"}}});
  assert.equal(invalid.error.code,-32602);assert.equal(f.calls.length,count);
});

test("layered instrument workflow resolves a preserved part and exact audio-bus routing",()=>{
  assert.ok(getProducerWorkflow().workflows.some(w=>w.name==="build-layered-instrument"));
  assert.throws(()=>getProducerWorkflow({workflow:"build-layered-instrument"}),/request/);
  assert.throws(()=>getProducerWorkflow({workflow:"build-layered-instrument",arguments:{request:"Layer this bass",mode:"replace"}}),/mode/);
  const text=getProducerWorkflow({workflow:"build-layered-instrument",arguments:{request:"Layer this bass",mode:"autonomous"}}).messages[0].content.text;
  for(const term of ["Layer this bass","duplicate_clip","Track In","No Input","busKind","inspect_producer_bus","manual edits"])assert.ok(text.includes(term),term);
  assert.match(text,/not.*phase|phase.*not/i);
});

test("shared blueprint discovery names the ordinary audio-bus route and inspector",()=>{
  const audio=getProducerChainBlueprint("layered-bass-system").execution.audioBus;
  assert.equal(audio.createTool,"create_track");assert.equal(audio.trackType,"audio");
  assert.equal(audio.routeTool,"set_track_routing");assert.equal(audio.verifyTool,"inspect_producer_bus");
  assert.equal(audio.busKind,"audio");assert.equal(audio.childOutputChannel,"Track In");
  assert.equal(getProducerChainBlueprint("bass").execution.audioBus,undefined);
});
