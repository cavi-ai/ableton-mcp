import test from "node:test";
import assert from "node:assert/strict";
import { enrichArrangementSection } from "../src/arrangement-section.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";

const note = (pitch,start,duration=1,mute=false) => ({pitch,start,duration,mute});
const part = (notes,extra={}) => ({trackId:"track-0",clipId:"track-0:arrangement-clip-0",status:"available",
  timeline:{startBeats:16,endBeats:28},clipTiming:{looping:true,loopStartBeats:2,loopEndBeats:6,startMarkerBeats:1,endMarkerBeats:10},notes,...extra});
const snapshot = (parts,startBeats=16,endBeats=28) => ({stateVersion:1,range:{startBeats,endBeats},
  musicalContext:{key:{rootNote:0,scaleName:"Major",scaleIntervals:[0,2,4,5,7,9,11]}},parts});
const weights = result => result.parts[0].tonalEvidence.pitchClasses.map(p=>[p.pitchClass,p.durationBeats]);

test("section projection includes the initial offset, loop repeats and trimmed final segment", () => {
  const result=enrichArrangementSection(snapshot([part([note(36,1),note(38,2),note(40,5,2),note(41,6),note(43,8)])]));
  assert.deepEqual(weights(result),[[0,1],[2,3],[4,2]]);
  assert.equal(result.parts[0].projectedNoteOverlaps,6);
  assert.equal(result.combined.confirmedKey,null);assert.deepEqual(result.combined.range,{startBeats:16,endBeats:28});
  assert.equal(Object.hasOwn(result.parts[0],"notes"),false);
});

test("a section inside later repeats does not replay the clip's initial lead-in", () => {
  const result=enrichArrangementSection(snapshot([part([note(36,1),note(38,2),note(40,5)])],22,27));
  assert.deepEqual(weights(result),[[2,1],[4,1]]);
});

test("nonlooping markers and sustained notes are clipped to both timeline and section", () => {
  const p=part([note(36,1,4),note(40,4,4),note(47,8,1),note(48,3,1,true)],{
    timeline:{startBeats:10,endBeats:16},clipTiming:{looping:false,startMarkerBeats:2,endMarkerBeats:8,loopStartBeats:0,loopEndBeats:4}});
  const result=enrichArrangementSection(snapshot([p],11,15));
  assert.deepEqual(weights(result),[[0,2],[4,3]]);assert.deepEqual(result.parts[0].pitchRange,{lowest:36,highest:40});
});

test("muted stored material remains visible while exclusions and empty windows are explicit", () => {
  const muted=part([note(36,2)],{track:{mute:true},clipMuted:true});
  const result=enrichArrangementSection(snapshot([muted,part([],{status:"audio"}),part([],{status:"drums"})]));
  assert.equal(result.coverage.status,"partial");assert.equal(result.coverage.analyzedParts,1);assert.equal(result.coverage.excludedParts,2);
  assert.equal(result.parts[0].clipMuted,true);assert.ok(result.parts[0].tonalEvidence.pitchClasses.length);
  assert.equal(result.parts[1].tonalEvidence,null);
  assert.equal(enrichArrangementSection(snapshot([])).coverage.status,"empty");
});

test("invalid timings, expansion bounds and malformed notes fail instead of sampling", () => {
  for(const p of [part([note(36,2)],{clipTiming:{looping:true,loopStartBeats:2,loopEndBeats:2,startMarkerBeats:1,endMarkerBeats:10}}),
    part([note(999,2)]),part([note(36,2)],{clipTiming:{looping:true,loopStartBeats:2,loopEndBeats:2.00001,startMarkerBeats:2,endMarkerBeats:3}})])
    assert.throws(()=>enrichArrangementSection(snapshot([p])));
});

test("section tool is read-only, all-profile, strictly validated and uses one native observation", async () => {
  const calls=[],service=new ToolService({bridge:{request:async(name,args)=>{calls.push([name,args]);return snapshot([part([note(36,2)])]);}}});
  const route=createRouter(service),tools=(await route({id:1,method:"tools/list"})).result.tools;
  assert.equal(tools.find(t=>t.name==="analyze_arrangement_section")?.annotations.readOnlyHint,true);
  calls.length=0;
  const args={startBeats:16,endBeats:28,trackIds:["track-0"]};
  const response=await route({id:2,method:"tools/call",params:{name:"analyze_arrangement_section",arguments:args}});
  assert.ok(response.result?.structuredContent);assert.deepEqual(calls,[["analyze_arrangement_section",args]]);
  for(const invalid of [{startBeats:2,endBeats:1},{startBeats:0,endBeats:513},{startBeats:-1,endBeats:2},{startBeats:0,endBeats:2,trackIds:[]},{startBeats:0,endBeats:2,trackIds:["track-0","track-0"]}]){
    const reply=await route({id:3,method:"tools/call",params:{name:"analyze_arrangement_section",arguments:invalid}});assert.ok(reply.error||reply.result?.isError);
  }
});
