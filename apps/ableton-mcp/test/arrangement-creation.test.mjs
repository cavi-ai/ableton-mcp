import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
import {getPrompt} from '../src/prompts.mjs';
const args={trackId:'track-0',startBeats:16,lengthBeats:4,name:'Verse chords',notes:[{pitch:60,start:0,duration:1,velocity:80}],expectedStateVersion:4};
function fixture(){
 let identity='track-a',trackName='Piano',writes=0;
 const receipt={stateVersion:5,verified:false,nativeReturned:true,createdClipId:'track-0:arrangement-clip-0',error:'note write failed'};
 const before=()=>({stateVersion:4,trackId:'track-0',identityToken:identity,trackName,startBeats:16,lengthBeats:4,endBeats:20,clips:[]});
 const service=new ToolService({bridge:{request:async(method,params)=>{
  if(method==='get_arrangement_creation_target')return before();
  assert.equal(method,'create_arrangement_midi_clip');assert.deepEqual(params.before,before());writes++;return receipt;
 }}});
 return {service,identity:v=>identity=v,name:v=>trackName=v,writes:()=>writes,receipt};
}
test('Arrangement creation binds notes, name and exact destination once and preserves partial receipt',async()=>{
 const f=fixture(),plan=await f.service.call('create_arrangement_midi_clip',args);assert.equal(f.writes(),0);assert.equal(plan.plan.name,args.name);assert.equal(plan.plan.notes[0].mute,false);
 const input={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
 f.identity('replacement');await assert.rejects(f.service.call('create_arrangement_midi_clip',input));f.identity('track-a');
 f.name('Manual label');await assert.rejects(f.service.call('create_arrangement_midi_clip',input));f.name('Piano');
 assert.deepEqual((await f.service.call('create_arrangement_midi_clip',input)).observed,f.receipt);
 await assert.rejects(f.service.call('create_arrangement_midi_clip',input));assert.equal(f.writes(),1);
});
test('Arrangement creation validates clip bounds, names and MIDI notes and remains outside core',async()=>{
 const f=fixture(),route=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 for(const change of [{lengthBeats:0},{startBeats:-1},{name:''},{name:'line\nbreak'},{notes:[{pitch:128,start:0,duration:1,velocity:80}]}])assert.equal((await route({id:1,method:'tools/call',params:{name:'create_arrangement_midi_clip',arguments:{...args,...change}}})).error.code,-32602);
 await assert.rejects(f.service.call('create_arrangement_midi_clip',{...args,notes:[{pitch:60,start:3,duration:2,velocity:80}]}));
 assert.equal((await core({id:2,method:'tools/call',params:{name:'create_arrangement_midi_clip',arguments:args}})).error.code,-32601);assert.equal(f.writes(),0);
});
test('sketch workflow supports Arrangement composition and preserves Session default',()=>{
 const text=getPrompt('create-musical-sketch',{request:'Add chords under the verse',location:'arrangement',mode:'autonomous'}).messages[0].content.text;
 assert.match(text,/create_arrangement_midi_clip/);assert.match(text,/audition_arrangement_passage/);
 assert.deepEqual(getPrompt('create-musical-sketch',{request:'A chord idea'}),getPrompt('create-musical-sketch',{request:'A chord idea',location:'session'}));
 assert.doesNotMatch(getPrompt('create-musical-sketch',{request:'A chord idea'}).messages[0].content.text,/create_arrangement_midi_clip/);
 assert.throws(()=>getPrompt('create-musical-sketch',{request:'A chord idea',location:'elsewhere'}));
});
