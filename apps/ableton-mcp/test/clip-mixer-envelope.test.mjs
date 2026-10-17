import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {validateToolArguments} from '../src/tool-validation.mjs';

const args={trackId:'track-0',clipId:'track-0:clip-0',mixerControl:'send',sendId:'send-0',returnTrackId:'return-0',expectedStateVersion:4,
  points:[{time:0,duration:2,targetDisplay:'-24 dB'},{time:2,duration:2,targetDisplay:'-12 dB'}]};

test('mixer envelope confirmation binds the exact send, Return and native context',async()=>{
  let identity='native-a',digest='mixer-a',exists=false,writes=0;
  const service=new ToolService({bridge:{request:async(method,params)=>{
    if(method==='get_clip_mixer_envelope_creation_context')return {stateVersion:4,trackId:args.trackId,clipId:args.clipId,mixerControl:'send',sendId:'send-0',returnTrackId:'return-0',
      identityToken:identity,contentDigest:'notes-a',parametersDigest:digest,envelopeExists:exists,returnName:'Reverb',points:[{time:0,duration:2,value:.36},{time:2,duration:2,value:.64}]};
    assert.equal(method,'create_clip_mixer_envelope');writes++;assert.deepEqual(params.points,args.points);
    return {stateVersion:5,trackId:args.trackId,clipId:args.clipId,mixerControl:'send',sendId:'send-0',returnTrackId:'return-0',created:true,verified:true,verificationScope:'sampled_steps'};
  }}});
  const plan=await service.call('create_clip_mixer_envelope',args);assert.equal(writes,0);
  const confirmed={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  identity='replacement';await assert.rejects(service.call('create_clip_mixer_envelope',confirmed),/hash mismatch/);identity='native-a';
  digest='changed';await assert.rejects(service.call('create_clip_mixer_envelope',confirmed),/hash mismatch/);digest='mixer-a';
  exists=true;await assert.rejects(service.call('create_clip_mixer_envelope',confirmed),/existing envelope/);exists=false;
  assert.equal((await service.call('create_clip_mixer_envelope',confirmed)).observed.verified,true);
  await assert.rejects(service.call('create_clip_mixer_envelope',confirmed));assert.equal(writes,1);
});

test('mixer selectors refuse ambiguous targets before native access',async()=>{
  let reads=0;
  const service=new ToolService({bridge:{request:async()=>{reads++;throw Error('unexpected native access');}}});
  for(const input of [{...args,mixerControl:'pan'},{...args,mixerControl:'volume'},
    {...args,sendId:undefined},{...args,returnTrackId:undefined}])await assert.rejects(service.call('create_clip_mixer_envelope',input),/mixerControl|sendId|returnTrackId|volume/);
  assert.equal(reads,0);
});

test('mixer envelope reads and creation are exposed only in the all profile',async()=>{
  const service=new ToolService({bridge:{request:async(method,params)=>{
    assert.equal(method,'get_clip_mixer_envelope');assert.equal(params.mixerControl,'volume');
    return {stateVersion:4,trackId:args.trackId,clipId:args.clipId,mixerControl:'volume',exists:false,samples:[]};
  }}}),all=createRouter(service),core=createRouter(service,{toolProfile:'core'});
  const read={trackId:args.trackId,clipId:args.clipId,mixerControl:'volume',sampleTimes:[0,.5]};
  assert.equal((await all({id:1,method:'tools/call',params:{name:'get_clip_mixer_envelope',arguments:read}})).result.structuredContent.exists,false);
  for(const name of ['get_clip_mixer_envelope','create_clip_mixer_envelope'])assert.equal((await core({id:2,method:'tools/call',params:{name,arguments:args}})).error.code,-32601);
  validateToolArguments('create_clip_mixer_envelope',args);
  assert.throws(()=>validateToolArguments('get_clip_mixer_envelope',{...read,sampleTimes:[-1]}));
  assert.throws(()=>validateToolArguments('create_clip_mixer_envelope',{...args,points:Array(129).fill({time:0,duration:1,value:1})}));
});
