import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

function fixture({clamp=false,readError=false,desynchronizedRange=false,changedEnd=false,retimed=false}={}){
 const state={stateVersion:3,trackId:'track-0',clipId:'track-0:clip-0',warping:false,markers:{unit:'seconds',startSeconds:.25,endSeconds:2},loop:{enabled:false,unit:'seconds',startSeconds:.25,endSeconds:2}},calls=[];
 const service=new ToolService({bridge:{request:async(name,args)=>{
  calls.push({name,args});
  if(name==='get_audio_clip_state'){if(readError&&state.stateVersion===4)throw Error('read unavailable');return structuredClone(state);}
  if(name==='set_audio_clip_state'){
   state.stateVersion=4;
   if(!clamp){state.markers.startSeconds=args.changes.startMarkerSeconds.value;if(!desynchronizedRange)state.loop.startSeconds=state.markers.startSeconds;}
   if(changedEnd)state.markers.endSeconds=state.loop.endSeconds=1.75;
   if(retimed){state.warpMarkers={supported:true,markers:[{sampleTime:.5,beatTime:0}]};state.timeline={startBeats:16,endBeats:19};}
   return structuredClone(state);
  }
  throw Error(name);
 }}});
 return {service,calls,state,args:{trackId:state.trackId,clipId:state.clipId,expectedStateVersion:3,startMarkerSeconds:.5}};
}
async function execute(f){const p=await f.service.call('set_audio_clip_state',f.args);return f.service.call('set_audio_clip_state',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});}
test('audio region writes get separate native bounds readback',async()=>{
 const f=fixture(),result=await execute(f);assert.equal(result.verification.markerBoundsConfirmed,true);
 assert.equal(f.calls.filter(c=>c.name==='set_audio_clip_state').length,1);
 assert.equal(f.calls.at(-1).name,'get_audio_clip_state');
});
test('an ignored native region setter remains explicitly unconfirmed',async()=>{
 const result=await execute(fixture({clamp:true}));assert.equal(result.verification.markerBoundsConfirmed,false);assert.ok(result.verification.mismatches.includes('startMarkerSeconds'));
});
test('readback failure retains the mutation result without asserting success',async()=>{
 const result=await execute(fixture({readError:true}));assert.equal(result.observed.stateVersion,4);assert.equal(result.verification.markerBoundsConfirmed,false);assert.match(result.verification.error,/unavailable/);
});
test('matching stored markers cannot hide a different active unwarped range',async()=>{
 const result=await execute(fixture({desynchronizedRange:true}));assert.equal(result.verification.markerBoundsConfirmed,false);assert.ok(result.verification.mismatches.includes('startMarkerSeconds'));
});
test('a native change to the omitted end remains explicitly unconfirmed',async()=>{
 const result=await execute(fixture({changedEnd:true}));assert.equal(result.verification.markerBoundsConfirmed,false);assert.ok(result.verification.mismatches.includes('endMarkerSeconds'));
});
test('inconsistent old-bridge bounds refuse planning without a write',async()=>{
 const f=fixture();f.state.markers.endSeconds=4;
 await assert.rejects(f.service.call('set_audio_clip_state',f.args),/updated native.*range/);
 assert.equal(f.calls.some(c=>c.name==='set_audio_clip_state'),false);
});
test('confirmed bounds separately disclose changed warp anchors and Arrangement context',async()=>{
 const f=fixture({retimed:true});f.state.warpMarkers={supported:true,markers:[{sampleTime:0,beatTime:0}]};f.state.timeline={startBeats:16,endBeats:20};
 const result=await execute(f);assert.equal(result.verification.markerBoundsConfirmed,true);
 assert.equal(result.verification.warpMarkersChanged,true);assert.equal(result.verification.arrangementContextChanged,true);
 assert.equal(result.observed.warpMarkers.markers[0].sampleTime,.5);
});
