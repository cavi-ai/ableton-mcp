import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {midiFileSource,importMidiFile,MacMidiImportHost} from '../src/midi-import.mjs';
import {ConfirmationStore} from '../src/confirmation-store.mjs';
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
const args={trackId:'track-1',clipId:'track-1:clip-0',sourcePath:'/Phrase.mid',expectedStateVersion:3,expectedSetFingerprint:'set'};
const plan=f=>importMidiFile(f.bridge,f.store,f.host,args),execute=(f,p)=>importMidiFile(f.bridge,f.store,f.host,{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
test('MIDI import plans are inert and confirmed imports report actual parts with limited verification',async()=>{const f=fixture(),p=await plan(f);assert.deepEqual(f.calls,[]);const result=await execute(f,p);assert.equal(result.importVerified,true);assert.equal(result.completePerformanceEquivalenceVerified,false);assert.deepEqual(f.calls,['select','picker','import']);});
test('changed source bytes invalidate confirmation before selection',async()=>{const f=fixture(),p=await plan(f);f.file.sha256='edited';await assert.rejects(execute(f,p),/context|plan|confirmation/);assert.deepEqual(f.calls,[]);});
test('unknown Open outcomes are inspected and never replayed',async()=>{const f=fixture();f.host.render=async()=>{f.calls.push('unknown');throw Object.assign(Error('lost Open reply'),{importRequested:null,requiresInspection:true});};const result=await execute(f,await plan(f));assert.equal(result.importRequested,null);assert.equal(result.importVerified,false);assert.equal(result.pendingUserAction,true);assert.equal(f.inspections,1);assert.deepEqual(f.calls,['select','unknown']);});
test('post-import source changes or incomplete native evidence withhold verification',async()=>{for(const setup of [f=>{f.host.render=async()=>({importRequested:true,uiComplete:false});},f=>{f.bridge.request=new Proxy(f.bridge.request,{apply:async(fn,thisArg,[method,a])=>method==='inspect_midi_import'?{targetClips:[],existingStructurePreserved:false}:fn(method,a)});}]){const f=fixture();setup(f);const result=await execute(f,await plan(f));assert.equal(result.importVerified,false);}});
test('lost picker or preparation replies require inspection without cancelling an unowned panel',async()=>{
 for(const lost of ['openPicker','prepare']){const calls=[],host=new MacMidiImportHost({execute:async()=>({stdout:'{"focused":true}'})});host.owner=async()=>({pid:1,appPath:'/Live.app'});host.call=async(owner,source,input)=>{calls.push(input.action);if(input.action===lost)throw Error('lost reply');if(input.action==='document')return {mainWindowId:1};if(input.action==='openPicker')return {windowId:2};return {};};await assert.rejects(host.render({}, {path:'/Phrase.mid'}, {mainWindowId:1},{beforeOpenPicker:async()=>{},beforeImport:async()=>{}}),e=>e.importRequested===false&&e.requiresInspection===true);assert.equal(calls.includes('cancel'),false);assert.equal(calls.includes('commit'),false);assert.equal(host.busy,false);}
});
