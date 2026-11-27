import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeMidi} from 'midi-file';
import {midiFileSource,importMidiFile,MacMidiImportHost} from '../src/midi-import.mjs';
import {ConfirmationStore} from '../src/confirmation-store.mjs';
import {ToolService} from '../src/tool-service.mjs';
const bytes=Buffer.from('4d546864000000060000000100604d54726b0000000400ff2f00','hex');
test('local MIDI source binds full bytes and rejects symlinks, unavailable files and wrong headers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cavi-midi-source-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'Phrase.mid');await writeFile(path,bytes);const source=await midiFileSource(path);assert.equal(source.format,0);assert.equal(source.tracks,1);assert.equal(source.sha256.length,64);await symlink(path,join(root,'Alias.mid'));await assert.rejects(midiFileSource(join(root,'Alias.mid')),/symlink|regular/);await writeFile(path,'bad');await assert.rejects(midiFileSource(path),/MIDI|header/);
});
function fixture(){
 let current={stateVersion:3,setFingerprint:'set',identityToken:'target',trackId:'track-1',clipId:'track-1:clip-0',filePath:'/Set.als',tracks:[],scenes:[]},inspections=0;
 const calls=[],file={path:'/Phrase.mid',sha256:'bytes',format:0,tracks:1},bridge={request:async(method,args)=>{
  if(method==='get_midi_import_target')return structuredClone(current);
  if(method==='select_midi_import_target'){calls.push('select');current={...current,stateVersion:4};return {source:structuredClone(current)};}
  if(method==='get_selection_context')return {selectedTrack:{id:'track-1'},highlightedClipSlot:{trackId:'track-1',clipId:'track-1:clip-0',hasClip:false}};
  if(method==='inspect_midi_import'){inspections++;return {targetClips:[{id:'track-1:clip-0',type:'midi'}],existingStructurePreserved:true,musicalUnchanged:true,recordingStopped:true,trackEffect:{addedTracksInspected:true,addedTracks:[]}};}
  throw Error(method);
 }},host={source:async()=>({...file}),context:async()=>({mainWindowId:1}),render:async(s,f,d,{beforeOpenPicker,beforeImport})=>{await beforeOpenPicker();calls.push('picker');await beforeImport();calls.push('import');return {importRequested:true,uiComplete:true};}};
 return {bridge,host,calls,file,store:new ConfirmationStore(),get inspections(){return inspections;}};
}
const args={route:'nativeDialog',trackId:'track-1',clipId:'track-1:clip-0',sourcePath:'/Phrase.mid',expectedStateVersion:3,expectedSetFingerprint:'set'};
const plan=f=>importMidiFile(f.bridge,f.store,f.host,args),execute=(f,p)=>importMidiFile(f.bridge,f.store,f.host,{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
test('MIDI import plans are inert and confirmed imports report actual parts with limited verification',async()=>{const f=fixture(),p=await plan(f);assert.deepEqual(f.calls,[]);const result=await execute(f,p);assert.equal(result.importVerified,true);assert.equal(result.completePerformanceEquivalenceVerified,false);assert.deepEqual(f.calls,['select','picker','import']);});
test('changed source bytes invalidate confirmation before selection',async()=>{const f=fixture(),p=await plan(f);f.file.sha256='edited';await assert.rejects(execute(f,p),/context|plan|confirmation/);assert.deepEqual(f.calls,[]);});
test('unknown Open outcomes are inspected and never replayed',async()=>{const f=fixture();f.host.render=async()=>{f.calls.push('unknown');throw Object.assign(Error('lost Open reply'),{importRequested:null,requiresInspection:true});};const result=await execute(f,await plan(f));assert.equal(result.importRequested,null);assert.equal(result.importVerified,false);assert.equal(result.pendingUserAction,true);assert.equal(f.inspections,1);assert.deepEqual(f.calls,['select','unknown']);});
test('a picker failure before Open reports its background cancel and needs no user action',async()=>{const f=fixture();f.host.render=async()=>{throw Object.assign(Error('Native MIDI file is not in the visible columns; no key was sent'),{importRequested:false,pickerCancelled:true,requiresInspection:false});};const result=await execute(f,await plan(f));assert.equal(result.importRequested,false);assert.equal(result.pickerCancelled,true);assert.equal(result.pendingUserAction,false);assert.match(result.verificationError,/visible columns/);});
test('post-import source changes or incomplete native evidence withhold verification',async()=>{for(const setup of [f=>{f.host.render=async()=>({importRequested:true,uiComplete:false});},f=>{f.bridge.request=new Proxy(f.bridge.request,{apply:async(fn,thisArg,[method,a])=>method==='inspect_midi_import'?{targetClips:[],existingStructurePreserved:false}:fn(method,a)});}]){const f=fixture();setup(f);const result=await execute(f,await plan(f));assert.equal(result.importVerified,false);}});
test('lost picker or preparation replies cancel the picker and report whether it closed',async()=>{
 for(const [lost,windowId] of [['openPicker',null],['prepare',2]])for(const closed of [true,false]){const calls=[],host=new MacMidiImportHost({execute:async()=>({stdout:'{"focused":true}'})});host.owner=async()=>({pid:1,appPath:'/Live.app'});host.call=async(owner,source,input)=>{calls.push(input);if(input.action===lost)throw Error('lost reply');if(input.action==='document')return {mainWindowId:1};if(input.action==='openPicker')return {windowId:2};if(input.action==='cancel')return {cancelled:closed};return {};};await assert.rejects(host.render({}, {path:'/Phrase.mid'}, {mainWindowId:1},{beforeOpenPicker:async()=>{},beforeImport:async()=>{}}),e=>e.importRequested===false&&e.pickerCancelled===closed&&e.requiresInspection===!closed);const cancels=calls.filter(c=>c.action==='cancel');assert.equal(cancels.length,1);assert.equal(cancels[0].windowId,windowId);assert.equal(calls.some(c=>c.action==='commit'),false);assert.equal(host.busy,false);}
});

test('commit cleans up a picker after a verified pre-Open failure and preserves it when Open is unknown',async()=>{
 for(const requested of [false,null]){
  const calls=[];
  const host=new MacMidiImportHost({execute:async(command,[,,script,payload])=>{
   if(script.endsWith('/live-app-focus.js'))return {stdout:'{"focused":true}'};
   const {action,windowId}=JSON.parse(payload);
   calls.push({action,windowId});
   if(action==='commit'){
    if(requested===null)throw Error('lost Open reply');
    return {stdout:JSON.stringify({error:'selection changed',importRequested:false,requiresInspection:false})};
   }
   const replies={document:{mainWindowId:1},inspect:{},openPicker:{windowId:2},
    prepare:{prepared:true,path:'/Phrase.mid'},cancel:{cancelled:true}};
   return {stdout:JSON.stringify(replies[action])};
  }});
  host.owner=async()=>({pid:1,appPath:'/Live.app'});
  await assert.rejects(host.render({}, {path:'/Phrase.mid'}, {mainWindowId:1},{
   beforeOpenPicker:async()=>{},beforeImport:async()=>{}
  }),error=>{
   assert.equal(error.importRequested,requested);
   assert.equal(error.pickerCancelled,requested===false?true:undefined);
   assert.equal(error.requiresInspection,requested===null);
   return true;
  });
  assert.deepEqual(calls.filter(c=>c.action==='cancel'),requested===false?[{action:'cancel',windowId:2}]:[]);
 }
});

const smf=events=>Buffer.from(writeMidi({header:{format:0,numTracks:1,ticksPerBeat:480},tracks:[[{deltaTime:0,meta:true,type:'trackName',text:'Bass'},{deltaTime:0,meta:true,type:'setTempo',microsecondsPerBeat:500000},{deltaTime:0,meta:true,type:'timeSignature',numerator:4,denominator:4,metronome:24,thirtyseconds:8},...events,{deltaTime:0,meta:true,type:'endOfTrack'}]]}));
const on=(deltaTime,noteNumber,velocity,channel=0)=>({deltaTime,type:'noteOn',channel,noteNumber,velocity}),off=(deltaTime,noteNumber,channel=0)=>({deltaTime,type:'noteOff',channel,noteNumber,velocity:0});
const bass=[on(0,36,100),off(480,36),on(240,43,90),off(240,43),{deltaTime:1920,meta:true,type:'marker',text:'end'}];
function bridgeFixture({readback=notes=>notes,readbackStateVersion=4,rejectWrite=false}={}){
 const calls=[];let created=null;
 const bridge={request:async(method,params)=>{calls.push({method,params:structuredClone(params)});
  if(method==='get_live_state')return {stateVersion:3,setFingerprint:'set',filePath:'/Set.als'};
  if(method==='list_tracks')return {stateVersion:3,tracks:[{id:'track-1',name:'Bass',type:'midi'},{id:'track-2',name:'Loop',type:'audio'}]};
  if(method==='list_clips')return {stateVersion:created?4:3,isFrozen:false,clips:[{id:params.trackId+':clip-0',name:created?.name??null,hasClip:!!created}]};
  if(method==='create_midi_import_clip'){
   if(rejectWrite)return {stateVersion:4,importRequested:false,verificationError:'MIDI import Set or state changed before clip creation'};
   created=structuredClone(params);return {stateVersion:4,trackId:params.trackId,clip:{id:params.clipId,name:params.name,hasClip:true,lengthBeats:params.lengthBeats,noteCount:params.notes.length,isPlaying:false}};}
  if(method==='get_midi_clip_notes')return {stateVersion:readbackStateVersion,trackId:params.trackId,clipId:params.clipId,lengthBeats:created.lengthBeats,notes:readback(structuredClone(created.notes))};
  throw Error('unexpected '+method);
 }};
 const touched=[],host=new Proxy({},{get:(target,key)=>{touched.push(String(key));throw Error('native host used');}});
 return {service:new ToolService({bridge,midiImportHost:host}),calls,touched};
}
const bridgeArgs=sourcePath=>({trackId:'track-1',clipId:'track-1:clip-0',sourcePath,expectedStateVersion:3,expectedSetFingerprint:'set'});
test('MIDI import writes the file notes into the slot through the bridge and verifies the readback without Live windows',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cavi-midi-bridge-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'bass.mid');await writeFile(path,smf(bass));
 for(const drift of [null,'notes','state']){
  const f=bridgeFixture(drift==='notes'?{readback:notes=>notes.map((n,i)=>i?n:{...n,velocity:1})}:
   drift==='state'?{readbackStateVersion:5}:{}),plan=await f.service.call('import_midi_file',bridgeArgs(path));
  assert.equal(plan.dryRun,true);assert.equal(plan.plan.route,'bridge');assert.equal(plan.plan.clip.name,'Bass');assert.equal(plan.plan.clip.lengthBeats,8);assert.equal(plan.plan.clip.noteCount,2);
  assert.equal(f.calls.some(c=>c.method==='create_midi_import_clip'),false);
  const result=await f.service.call('import_midi_file',{...bridgeArgs(path),dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  const write=f.calls.filter(c=>c.method==='create_midi_import_clip');assert.equal(write.length,1);
  assert.equal(write[0].params.expectedStateVersion,3);
  assert.equal(write[0].params.expectedSetFingerprint,'set');
  assert.deepEqual(write[0].params.before,{id:'track-1:clip-0',name:null,hasClip:false});
  assert.equal(write[0].params.name,'Bass');assert.equal(write[0].params.lengthBeats,8);
  assert.deepEqual(write[0].params.notes,[{pitch:36,start:0,duration:1,velocity:100,mute:false},{pitch:43,start:1.5,duration:0.5,velocity:90,mute:false}]);
  assert.equal(result.importVerified,!drift);assert.equal(result.pendingUserAction,false);
  assert.equal(result.operationOutcome.status,drift?'outcome_unknown':'applied');
  assert.deepEqual(f.touched,[]);
 }
});
test('MIDI import reports a bridge refusal without reading back a different slot',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cavi-midi-stale-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'bass.mid');
 await writeFile(path,smf(bass));
 const f=bridgeFixture({rejectWrite:true}),args=bridgeArgs(path),plan=await f.service.call('import_midi_file',args);
 const result=await f.service.call('import_midi_file',{...args,dryRun:false,
  confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
 assert.equal(result.importRequested,false);
 assert.equal(result.importVerified,false);
 assert.equal(result.pendingUserAction,false);
 assert.match(result.verificationError,/Set or state changed/);
 assert.equal(f.calls.at(-1).method,'create_midi_import_clip');
});

test('MIDI import refuses files the bridge cannot write exactly and non-MIDI targets before any write',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cavi-midi-refuse-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cases=[['pedal.mid',[on(0,36,100),{deltaTime:0,type:'controller',channel:0,controllerType:64,value:127},off(480,36)],/1 controller events; bridge import writes notes only/],
  ['channels.mid',[on(0,36,100),on(0,48,100,1),off(480,36),off(0,48,1)],/2 channels/],
  ['overlap.mid',[on(0,40,100),on(240,40,100),off(240,40),off(240,40)],/overlapping notes on pitch 40/]];
 for(const [name,events,reason] of cases){const path=join(root,name);await writeFile(path,smf(events));const f=bridgeFixture();await assert.rejects(f.service.call('import_midi_file',bridgeArgs(path)),reason);assert.equal(f.calls.some(c=>c.method==='create_midi_import_clip'),false);assert.deepEqual(f.touched,[]);}
 const path=join(root,'bass.mid');await writeFile(path,smf(bass));const f=bridgeFixture();
 await assert.rejects(f.service.call('import_midi_file',{...bridgeArgs(path),trackId:'track-2',clipId:'track-2:clip-0'}),/must be a MIDI track/);
});
