import test from "node:test";
import assert from "node:assert/strict";
import { enrichArrangementSection } from "../src/arrangement-section.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";

const note = (pitch,start,duration=1,mute=false) => ({pitch,start,duration,mute});
const part = (index,notes,extra={}) => ({trackId:`track-${index}`,clipId:`track-${index}:arrangement-clip-0`,status:"available",
  timeline:{startBeats:0,endBeats:8},clipTiming:{looping:false,startMarkerBeats:0,endMarkerBeats:8},notes,...extra});
const snapshot = (parts,startBeats=0,endBeats=8) => ({stateVersion:1,range:{startBeats,endBeats},
  musicalContext:{key:{rootNote:0,scaleName:"Major",scaleIntervals:[0,2,4,5,7,9,11]}},parts});
const analyze = value => enrichArrangementSection(value,{includeHarmony:true});
const compact = result => result.harmony.intervals.map(i=>[i.startBeats,i.endBeats,i.status,i.candidates.map(c=>c.symbol)]);

test("shared harmonic intervals distinguish simultaneous parts from passage-wide totals", () => {
  const value=snapshot([part(0,[note(36,0,2),note(38,2,2)]),part(1,[note(64,0,2),note(67,0,2),note(65,2,2),note(69,2,2)])],0,4);
  const result=analyze(value);
  assert.deepEqual(compact(result),[[0,2,"candidate",["C"]],[2,4,"candidate",["Dm"]]]);
  assert.deepEqual(result.harmony.intervals[0].pitches,[36,64,67]);
  assert.deepEqual(result.harmony.intervals[0].parts,[{trackId:"track-0",clipId:"track-0:arrangement-clip-0"},{trackId:"track-1",clipId:"track-1:arrangement-clip-0"}]);
  assert.equal(result.harmony.intervals[0].candidates[0].romanNumeral,null);
  assert.equal(result.combined.confirmedKey,null);
  assert.deepEqual(result.combined,enrichArrangementSection(value).combined);
  assert.equal(Object.hasOwn(enrichArrangementSection(value),"harmony"),false);
});

test("note endings, sparse material, gaps and repeated chords remain separate intervals", () => {
  const result=analyze(snapshot([part(0,[note(60,0,3),note(64,0,1),note(67,0,3),... [60,64,67].map(p=>note(p,4,1))])],0,5));
  assert.deepEqual(compact(result),[[0,1,"candidate",["C"]],[1,3,"sparse",[]],[3,4,"empty",[]],[4,5,"candidate",["C"]]]);
  assert.equal(result.harmony.intervals[2].bassPitch,null);
  assert.deepEqual(result.harmony.intervals[2].parts,[]);
});

test("loop offsets and window clipping preserve sustained pitch sets without inventing attacks", () => {
  const p=part(0,[note(60,1,3),note(64,2,2),note(67,2,2)],{
    timeline:{startBeats:16,endBeats:24},clipTiming:{looping:true,startMarkerBeats:1,endMarkerBeats:8,loopStartBeats:2,loopEndBeats:4}});
  assert.deepEqual(compact(analyze(snapshot([p],16,24))),[[16,17,"sparse",[]],[17,24,"candidate",["C"]]]);
  assert.deepEqual(compact(analyze(snapshot([p],18,22))),[[18,22,"candidate",["C"]]]);
});

test("fractional repeats share exact boundaries while genuine short gaps remain visible", () => {
  const length=4/3;
  const fixture=duration=>snapshot([part(0,[60,64,67].map(p=>note(p,0,duration)),{
    timeline:{startBeats:16,endBeats:24},clipTiming:{looping:true,startMarkerBeats:0,endMarkerBeats:length,loopStartBeats:0,loopEndBeats:length}})],16,24);
  assert.deepEqual(compact(analyze(fixture(length))),[[16,24,"candidate",["C"]]]);
  const gaps=analyze(fixture(length-0.000001)).harmony.intervals.filter(i=>i.status==="empty");
  assert.ok(gaps.length>=5);
  assert.ok(gaps.every(i=>Math.abs(i.endBeats-i.startBeats-0.000001)<1e-12));
});

test("ambiguity, unknown sets, muted material and exclusions are explicit", () => {
  const value=snapshot([part(0,[... [60,64,68].map(p=>note(p,0,1)),... [60,61,66].map(p=>note(p,1,1)),note(70,0,2,true)],{track:{mute:true},clipMuted:true}),part(1,[],{status:"audio"})],0,2);
  const result=analyze(value);
  assert.equal(result.coverage.status,"partial");
  assert.equal(result.harmony.intervals[0].status,"ambiguous");assert.equal(result.harmony.intervals[0].candidates.length,3);
  assert.equal(result.harmony.intervals[1].status,"unrecognized");
  assert.deepEqual(result.harmony.intervals[1].candidates,[]);
  assert.equal(analyze(snapshot([])).harmony,null);
  assert.equal(analyze(snapshot([part(0,[],{status:"drums"})])).harmony,null);
});

test("optional harmony limits reject excessive projected notes or intervals without changing tonal-only reads", () => {
  const repeated=part(0,Array.from({length:2049},()=>note(60,0,1)),{
    timeline:{startBeats:0,endBeats:2},clipTiming:{looping:true,startMarkerBeats:0,endMarkerBeats:1,loopStartBeats:0,loopEndBeats:1}});
  assert.throws(()=>analyze(snapshot([repeated],0,2)),/4096.*projected|projected.*4096/);
  assert.ok(enrichArrangementSection(snapshot([repeated],0,2)).combined);
  const changing=part(0,Array.from({length:257},(_,i)=>note(60+i%2,i,1)),{timeline:{startBeats:0,endBeats:257},clipTiming:{looping:false,startMarkerBeats:0,endMarkerBeats:257}});
  assert.throws(()=>analyze(snapshot([changing],0,257)),/256.*interval|interval.*256/);
});

test("MCP harmony option remains read-only and uses the same single native observation", async () => {
  const calls=[],service=new ToolService({bridge:{request:async(name,args)=>{calls.push([name,args]);return snapshot([part(0,[60,64,67].map(p=>note(p,0,2)))],0,2);}}});
  const route=createRouter(service),args={startBeats:0,endBeats:2,includeHarmony:true};
  const response=await route({id:1,method:"tools/call",params:{name:"analyze_arrangement_section",arguments:args}});
  assert.deepEqual(response.result?.structuredContent?.harmony.intervals[0].candidates.map(c=>c.symbol),["C"]);
  assert.deepEqual(calls,[["analyze_arrangement_section",args]]);
  const bad=await route({id:2,method:"tools/call",params:{name:"analyze_arrangement_section",arguments:{...args,includeHarmony:"yes"}}});
  assert.equal(bad.error?.code,-32602);
});
