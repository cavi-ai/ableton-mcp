import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {ToolService} from '../src/tool-service.mjs';

function fixture(){
 const source={stateVersion:4,filePath:'/set.als',setName:'set',identityToken:'song-a',scriptDirectory:'/Live.app/Contents/App-Resources/MIDI Remote Scripts/CaviMcpBridge',
  transport:{stateVersion:4,isPlaying:false,metronome:false,countInDuration:{value:0,name:'none',choices:[{value:0,name:'none'},{value:1,name:'one_bar'},{value:2,name:'two_bars'},{value:3,name:'four_bars'}]}},
  recording:{arrangement:false,session:false,countingIn:false}},calls=[],host={
  async prepare(before,{beforePrepare}){await beforePrepare();calls.push('prepare');return {id:'owned-menu'};},
  async commit(before,prepared,target,{beforeCommit}){await beforeCommit();calls.push('commit');source.transport.countInDuration.value=target.countInDuration;source.transport.countInDuration.name=source.transport.countInDuration.choices[target.countInDuration].name;source.transport.metronome=target.metronome;return {operationRequested:true,popupClosed:true};},
  async cancel(){calls.push('cancel');return {cancelled:true};}
 };
 const service=new ToolService({bridge:{async request(method){if(method==='get_transport_context')return structuredClone(source.transport);assert.equal(method,'get_recording_setup_source');return structuredClone(source);}},recordingSetupHost:host});
 return {service,source,host,calls,args:{expectedStateVersion:4,countInDuration:'one_bar',metronome:true}};
}
const confirm=(args,p)=>({...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
test('native flags and Count-In inventory reject unknown values and ambiguous radio choices',async()=>{
 const helpers=vm.runInNewContext((await readFile(new URL('../src/live-recording-setup.js',import.meta.url),'utf8'))+';({recordingSetupFlag,recordingSetupCountIndex})');
 for(const value of [null,undefined,'','0',2,{}])assert.throws(()=>helpers.recordingSetupFlag(value),/unknown/);
 const entries=['None','1 Bar','2 Bars','4 Bars'].map((name,i)=>({name,enabled:true,selected:i===1}));
 assert.equal(helpers.recordingSetupCountIndex(entries),1);
 for(const change of [e=>e[0].selected=true,e=>e[1].selected=false,e=>e[1].enabled=false,e=>e[0].name='Auto']){const e=structuredClone(entries);change(e);assert.throws(()=>helpers.recordingSetupCountIndex(e));}
});
test('popup closure requires both AX absence and disappearance of owned visible windows',async()=>{
 const closed=vm.runInNewContext((await readFile(new URL('../src/live-recording-setup.js',import.meta.url),'utf8'))+';recordingSetupPopupClosed');
 assert.equal(closed(0,[8],[9]),true);assert.equal(closed(0,[8,9],[9]),false);assert.equal(closed(1,[8],[9]),false);
 assert.equal(closed(0,[8],[]),false);
});
test('existing count-in API plans inertly, uses owned UI and verifies native values',async()=>{
 const f=fixture(),p=await f.service.call('set_transport_context',f.args);assert.deepEqual(f.calls,[]);
 const result=await f.service.call('set_transport_context',confirm(f.args,p));assert.equal(result.transportVerified,true);
 assert.equal(result.observed.countInDuration.name,'one_bar');assert.equal(result.observed.metronome,true);
 assert.deepEqual(f.calls,['prepare','commit']);await assert.rejects(f.service.call('set_transport_context',confirm(f.args,p)));
});
test('unsafe playback/recording, unsaved Sets and stale identity refuse before menu input',async()=>{
 for(const change of [f=>f.source.transport.isPlaying=true,f=>f.source.recording.arrangement=true,f=>f.source.recording.session=true,f=>f.source.recording.countingIn=true,f=>f.source.filePath='']){
  const f=fixture();change(f);await assert.rejects(f.service.call('set_transport_context',f.args));assert.deepEqual(f.calls,[]);
 }
 const f=fixture(),p=await f.service.call('set_transport_context',f.args);f.source.identityToken='replacement';
 await assert.rejects(f.service.call('set_transport_context',confirm(f.args,p)));assert.deepEqual(f.calls,[]);
});
test('changed context during menu preparation cancels only the owned menu',async()=>{
 const f=fixture(),prepare=f.host.prepare;f.host.prepare=async(...args)=>{const result=await prepare(...args);f.source.transport.metronome=true;return result;};
 const p=await f.service.call('set_transport_context',f.args),r=await f.service.call('set_transport_context',confirm(f.args,p));
 assert.equal(r.transportVerified,false);assert.deepEqual(f.calls,['prepare','cancel']);
});
test('partial UI changes return observed native values without rollback or replay',async()=>{
 const f=fixture();f.host.commit=async()=>{f.calls.push('commit');f.source.transport.countInDuration={...f.source.transport.countInDuration,value:1,name:'one_bar'};throw Object.assign(Error('metronome was unavailable'),{operationRequested:null});};
 const p=await f.service.call('set_transport_context',f.args),r=await f.service.call('set_transport_context',confirm(f.args,p));
 assert.equal(r.transportVerified,false);assert.equal(r.observed.countInDuration.value,1);assert.equal(r.observed.metronome,false);assert.equal(f.calls.filter(c=>c==='commit').length,1);
});
