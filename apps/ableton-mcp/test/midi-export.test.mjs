import test from 'node:test';
import assert from 'node:assert/strict';
import {writeMidi} from 'midi-file';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectMidiBytes,verifyMidiArtifact} from '../src/midi-export.mjs';
const file=(events=[{deltaTime:0,channel:0,type:'noteOn',noteNumber:60,velocity:100},{deltaTime:96,channel:0,type:'noteOff',noteNumber:60,velocity:20},{deltaTime:96,meta:true,type:'endOfTrack'}])=>Buffer.from(writeMidi({header:{format:0,numTracks:1,ticksPerBeat:96},tracks:[events]}));
test('MIDI inspection reads complete notes, release velocity and end-of-track length',()=>{
 const r=inspectMidiBytes(file());assert.equal(r.format,0);assert.equal(r.ticksPerBeat,96);assert.equal(r.endBeats,2);assert.deepEqual(r.notes,[{channel:0,pitch:60,start:0,duration:1,velocity:100,releaseVelocity:20}]);
});
test('MIDI inspection refuses truncated chunks, trailing bytes, incomplete notes and missing end markers',()=>{
 for(const b of [file().subarray(0,20),Buffer.concat([file(),Buffer.from([0])]),file([{deltaTime:0,channel:0,type:'noteOn',noteNumber:60,velocity:100},{deltaTime:96,meta:true,type:'endOfTrack'}]),file([{deltaTime:0,meta:true,type:'text',text:'not complete'}])])assert.throws(()=>inspectMidiBytes(b),/MIDI|track|note|end/i);
});
test('artifact verification hashes a complete regular MIDI file and refuses symlinks',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cavi-midi-export-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'Phrase.mid');await writeFile(path,file());const r=await verifyMidiArtifact(path);assert.equal(r.verified,true);assert.equal(r.sha256.length,64);assert.equal(r.notes.length,1);await symlink(path,join(root,'Linked.mid'));await assert.rejects(verifyMidiArtifact(join(root,'Linked.mid')),/regular|symlink/);
});

import {saveMidiClip} from '../src/midi-export.mjs';
import {ConfirmationStore} from '../src/confirmation-store.mjs';
function workflow(){let current={stateVersion:3,identityToken:'clip',setFingerprint:'set',trackId:'track-0',clipId:'track-0:clip-0',name:'Phrase',notes:[{noteId:7,pitch:60,start:0,duration:1,velocity:100,releaseVelocity:20,mute:false,probability:1,velocityDeviation:0}],timing:{stateVersion:3,loop:{startBeats:0,endBeats:4}}};const calls=[],bridge={request:async(method,args)=>{if(method==='get_midi_export_source')return structuredClone(current);if(method==='get_selection_context')return {selectedTrack:{id:'track-0'},detailClip:{trackId:'track-0',clipId:'track-0:clip-0'}};if(method==='select_midi_export_source'){calls.push('select');current={...current,stateVersion:4,timing:{...current.timing,stateVersion:4}};return {source:structuredClone(current)};}throw Error(method);}},host={destination:async()=>({path:'/Exports/Phrase.mid',parent:{path:'/Exports',dev:'1',ino:'2'}}),render:async(s,d,{beforeExport,beforeSave})=>{await beforeExport();calls.push('menu');await beforeSave();calls.push('save');return {saveRequested:true,uiComplete:true};},verify:async()=>({verified:true,notes:inspectMidiBytes(file()).notes,ticksPerBeat:96,sha256:'file'})};return {bridge,host,calls,store:new ConfirmationStore(),get source(){return current;}};}
const input={trackId:'track-0',clipId:'track-0:clip-0',path:'/Exports/Phrase.mid',expectedStateVersion:3};
const plan=f=>saveMidiClip(f.bridge,f.store,f.host,input),execute=(f,p)=>saveMidiClip(f.bridge,f.store,f.host,{...input,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
test('MIDI export planning is inert and a confirmed save verifies the exact source and file',async()=>{const f=workflow(),p=await plan(f);assert.deepEqual(f.calls,[]);const r=await execute(f,p);assert.equal(r.exportVerified,true);assert.equal(r.sourcePreserved,true);assert.equal(r.noteComparison.pitchTimingVelocityMatch,true);assert.deepEqual(f.calls,['select','menu','save']);});
test('an intervening source edit refuses before native selection',async()=>{const f=workflow(),p=await plan(f);f.source.notes[0].pitch=62;await assert.rejects(execute(f,p),/changed/);assert.deepEqual(f.calls,[]);});
test('post-selection edits, incomplete UI and invalid artifacts withhold export verification',async()=>{for(const setup of [f=>{const render=f.host.render;f.host.render=async(...a)=>{f.source.notes[0].velocity=20;return render(...a);};},f=>{f.host.render=async()=>({saveRequested:true,uiComplete:false});},f=>{f.host.verify=async()=>{throw Error('missing file');};}]){const f=workflow();setup(f);const r=await execute(f,await plan(f));assert.equal(r.exportVerified,false);assert.ok(f.calls.filter(c=>c==='save').length<=1);}});
test('an unknown Save is never replayed or treated as complete',async()=>{const f=workflow();f.host.render=async()=>{throw Object.assign(Error('unknown Save'),{saveRequested:null});};const r=await execute(f,await plan(f));assert.equal(r.saveRequested,null);assert.equal(r.exportVerified,false);assert.equal(r.pendingUserAction,true);assert.deepEqual(f.calls,['select']);});

import {MacMidiExportHost} from '../src/midi-export.mjs';
import {mkdir,rename} from 'node:fs/promises';
test('destination reservations reject existing/broken links and recheck the actual directory identity',async t=>{const root=await mkdtemp(join(tmpdir(),'cavi-midi-destination-'));t.after(()=>rm(root,{recursive:true,force:true}));const folder=join(root,'exports');await mkdir(folder);const host=new MacMidiExportHost(),path=join(folder,'Phrase.mid'),reserved=await host.reserve(path);for(const input of ['relative.mid',join(folder,'.hidden.mid'),join(folder,'Wrong.wav')])await assert.rejects(host.reserve(input));await symlink(join(root,'missing'),path);await assert.rejects(host.reserve(path),/exists/);await rm(path);await host.recheckDestination({...reserved,document:{mainWindowId:1}});await rename(folder,folder+'-old');await mkdir(folder);await assert.rejects(host.recheckDestination({...reserved,document:{mainWindowId:1}}),/directory changed/);});

import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';
test('MIDI export is guarded and discoverable only in all, with invalid calls rejected before Live',async()=>{let calls=0;const service=new ToolService({bridge:{request:async()=>{calls++;throw Error('unexpected bridge call');}}}),all=createRouter(service),core=createRouter(service,{toolProfile:'core'});const tool=(await all({id:1,method:'tools/list'})).result.tools.find(t=>t.name==='export_midi_clip');assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.destructiveHint,true);const discoveryCalls=calls;assert.equal((await core({id:2,method:'tools/call',params:{name:'export_midi_clip',arguments:input}})).error.code,-32601);const bad=await all({id:3,method:'tools/call',params:{name:'export_midi_clip',arguments:{trackId:'track-0',clipId:'track-0:clip-0',path:'/Exports/Phrase.mid'}}});assert.ok(bad.error);assert.equal(calls,discoveryCalls);});
test('native UI arguments exclude the potentially large note snapshot',async()=>{let payload;const host=new MacMidiExportHost({execute:async(command,args)=>{payload=JSON.parse(args.at(-1));return {stdout:'{}'};}}),script=new URL('../src/live-midi-export.js',import.meta.url).pathname;await host.call(script,{source:{filePath:'',name:'Phrase',trackUIPath:'.Track[0]',clipId:'track-0:clip-0',location:'session',notes:Array(4096).fill({pitch:60,start:0,duration:4})},action:'document'});assert.equal('notes' in payload.source,false);assert.equal(payload.source.clipId,'track-0:clip-0');assert.ok(JSON.stringify(payload).length<1024);});
test('lost Export or Save-panel adoption replies require inspection without cancelling an unowned panel',async()=>{
 for(const lost of ['open','adoptMidiExport']){
  const calls=[],host=new MacMidiExportHost({execute:async()=>({stdout:'{"focused":true}'})});
  host.owner=async()=>({pid:1,appPath:'/Live.app'});
  host.call=async(script,input)=>{calls.push(input.action);if(input.action===lost)throw Error('lost reply');if(input.action==='document')return {mainWindowId:7};if(input.action==='open')return {saveWindowId:8};return {};};
  await assert.rejects(host.render({}, {document:{mainWindowId:7},parent:{path:'/Exports'}},{beforeExport:async()=>{},beforeSave:async()=>{}}),error=>error.saveRequested===false&&error.requiresInspection===true);
  assert.equal(calls.includes('cancel'),false);assert.equal(calls.includes('commit'),false);assert.equal(host.busy,false);
 }
 const f=workflow();f.host.render=async()=>{throw Object.assign(Error('lost preparation reply'),{saveRequested:false,requiresInspection:true});};
 const result=await execute(f,await plan(f));assert.equal(result.pendingUserAction,true);assert.equal(result.saveRequested,false);
});
