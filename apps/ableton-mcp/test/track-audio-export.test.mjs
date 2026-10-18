import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import * as exporter from '../src/audio-export.mjs';
import {ConfirmationStore} from '../src/confirmation-store.mjs';
import {createRouter} from '../src/server.mjs';
import {ToolService} from '../src/tool-service.mjs';

const source=()=>({stateVersion:3,setFingerprint:'set',identityToken:'document',renderTargets:[
  {trackId:'track-0',name:'Part',hasAudioOutput:true},
  {trackId:'track-1',name:'MIDI only',hasAudioOutput:false},
  {trackId:'track-2',name:'Part',hasAudioOutput:true},
  {trackId:'return-0',name:'A-Reverb',hasAudioOutput:true}
]});
const args={trackId:'track-2',path:'/exports/Part.wav',start:'1.1.1',length:'4.0.0',expectedStateVersion:3,expectedSetFingerprint:'set'};

test('individual export binds an eligible exact track and keeps duplicate-name menu positions',async()=>{
  assert.equal(typeof exporter.exportAudioTrack,'function');
  const before=source();let renders=0,settings;
  const bridge={request:async()=>structuredClone(before)};
  const host={appPathFor:()=>'/Live.app',destination:async path=>({path}),render:async(app,s,d,{beforeExport,beforeSave})=>{renders++;settings=s;await beforeExport();await beforeSave();return {exportRequested:true,uiComplete:true,trackSelectionVerified:true,publicationVerified:true};},verify:async()=>({verified:true,durationSeconds:8})};
  const store=new ConfirmationStore(),p=await exporter.exportAudioTrack(bridge,store,host,args);
  assert.equal(renders,0);assert.equal(p.plan.method,'export_audio_track');
  assert.deepEqual(p.plan.settings.renderTarget,{trackId:'track-2',name:'Part',menuIndex:4,menuTitles:['Main','All Individual Tracks','Selected Tracks Only','Part','Part','A-Reverb']});
  assert.equal(p.plan.settings.includeReturnMainEffects,false);
  const r=await exporter.exportAudioTrack(bridge,store,host,{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});
  assert.equal(renders,1);assert.equal(settings.renderTarget.trackId,'track-2');assert.equal(r.artifactVerified,true);assert.equal(r.exportVerified,false);assert.equal(r.renderCompletion,'unconfirmed');
});

test('ineligible, ambiguous, unknown and changed track inventories refuse export',async()=>{
  assert.equal(typeof exporter.exportAudioTrack,'function');
  for(const trackId of ['track-1','track-99','track-02','master']){
    const host={appPathFor:()=>'/Live.app',destination:async path=>({path})};
    await assert.rejects(exporter.exportAudioTrack({request:async()=>source()},new ConfirmationStore(),host,{...args,trackId}));
  }
  const before=source(),bridge={request:async()=>structuredClone(before)},host={appPathFor:()=>'/Live.app',destination:async path=>({path})},store=new ConfirmationStore();
  const p=await exporter.exportAudioTrack(bridge,store,host,args);
  before.renderTargets[0].hasAudioOutput=false;
  await assert.rejects(exporter.exportAudioTrack(bridge,store,host,{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}),/hash mismatch/);
  before.renderTargets[0].hasAudioOutput=null;
  await assert.rejects(exporter.exportAudioTrack(bridge,store,host,args),/output|inventory/);
  before.renderTargets=source().renderTargets;before.renderTargets.push({...before.renderTargets[0]});
  await assert.rejects(exporter.exportAudioTrack(bridge,store,host,args),/duplicate|inventory/);
});

test('Return output and shared effects are an explicit render choice',async()=>{
  const host={appPathFor:()=>'/Live.app',destination:async path=>({path})};
  const p=await exporter.exportAudioTrack({request:async()=>source()},new ConfirmationStore(),host,{...args,trackId:'return-0',includeReturnMainEffects:true});
  assert.equal(p.plan.settings.renderTarget.menuIndex,5);
  assert.equal(p.plan.settings.renderTarget.name,'A-Reverb');
  assert.equal(p.plan.settings.includeReturnMainEffects,true);
});

test('native menu resolution distinguishes duplicate names and rejects a changed list or selected duplicate',async()=>{
  const script=await readFile(new URL('../src/live-audio-export-dialog.js',import.meta.url),'utf8');
  const resolve=runInNewContext(script+'; typeof resolveRenderedTrackMenu === "function" ? resolveRenderedTrackMenu : null');
  assert.equal(typeof resolve,'function');
  const target={trackId:'track-2',name:'Part',menuIndex:4,menuTitles:['Main','All Individual Tracks','Selected Tracks Only','Part','Part','A-Reverb']};
  const menu=target.menuTitles.map((title,i)=>({title:(i===4?'✔ ':'')+title,selected:i===4,enabled:true}));
  assert.equal(resolve(menu,target,true),4);
  const changed=structuredClone(menu);changed[3].selected=true;changed[3].title='✔ Part';changed[4].selected=false;changed[4].title='Part';
  assert.throws(()=>resolve(changed,target,true),/selection/);
  assert.equal(resolve(changed,target,false),4);
  assert.throws(()=>resolve(menu.slice(0,-1),target,false),/inventory/);
  assert.throws(()=>resolve(menu,{...target,menuIndex:3,name:'Wrong'},false),/target/);
  const literal={...target,menuTitles:[...target.menuTitles]};literal.menuTitles[3]='✔ Part';const literalMenu=menu.map(x=>({...x}));literalMenu[3].title='✔ Part';assert.equal(resolve(literalMenu,literal,true),4);
});

test('individual audio export is all-profile only and rejects invalid effect scope before host access',async()=>{
  const calls=[],service=new ToolService({bridge:{request:async(...x)=>{calls.push(x);throw Error('not needed');}}});
  const all=createRouter(service),core=createRouter(service,{toolProfile:'core'});
  const listed=await all({id:1,method:'tools/list'});assert.ok(listed.result.tools.some(x=>x.name==='export_audio_track')); const discoveryCalls=calls.length;
  for(const input of [{...args,includeReturnMainEffects:'yes'},{...args,trackId:undefined}])assert.equal((await all({id:2,method:'tools/call',params:{name:'export_audio_track',arguments:input}})).error?.code,-32602);
  assert.equal((await core({id:3,method:'tools/call',params:{name:'export_audio_track',arguments:args}})).error?.code,-32601);assert.equal(calls.length,discoveryCalls);
});

test('track-stem workflow is discoverable and validates required intent without Live mutations',async()=>{
 const route=createRouter(new ToolService({bridge:{request:async()=>{throw Error('workflow retrieval does not call Live');}}}),{toolProfile:'producer'});
 const args={request:'Export the verse chords and bass to separate new WAVs with the same range; leave the mix controls unchanged.'};
 const p=await route({id:1,method:'prompts/get',params:{name:'export-track-stems',arguments:args}});
 assert.ok(p.result?.messages[0].content.text.includes(args.request));
 const t=await route({id:2,method:'tools/call',params:{name:'get_producer_workflow',arguments:{workflow:'export-track-stems',arguments:args}}});
 assert.deepEqual(t.result.structuredContent,{workflow:'export-track-stems',...p.result});
 assert.equal((await route({id:3,method:'prompts/get',params:{name:'export-track-stems',arguments:{}}})).error?.code,-32602);
});

test('a changed native selected track preserves the dialog without Export, Save or cleanup input',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'cavi-track-export-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const app=join(root,'Live.app');await mkdir(join(app,'Contents/MacOS'),{recursive:true});await writeFile(join(app,'Contents/MacOS/Live'),'binary');
 const calls=[],host=new exporter.MacAudioExportHost({platform:'darwin',liveSetHost:{runningProcesses:async()=>[{pid:42,path:app+'/Contents/MacOS/Live'}]},execute:async(command,args)=>{
   if(command==='/usr/bin/open')return {stdout:''};
   if(args[2].endsWith('live-app-focus.js'))return {stdout:JSON.stringify({focused:true})};
   const input=JSON.parse(args.at(-1));calls.push(input.action);
   if(input.action==='prepare')return {stdout:JSON.stringify({prepared:true,windowId:1,panelState:{},renderTarget:{trackId:'track-2'}})};
   if(input.action==='commit')return {stdout:JSON.stringify({exportPressed:false,preserveDialog:true,error:'Native rendered-track selection changed'})};
   throw Error('unexpected UI input');
 }});
 await assert.rejects(host.render(app,{renderTarget:{trackId:'track-2'}},{parent:{path:root},name:'Part.wav'},{beforeExport:async()=>{},beforeSave:async()=>{throw Error('must not reach Save');}}),/selection changed/);
 assert.deepEqual(calls,['prepare','commit']);
});

test('native track filename suffixes stay in staging and publish only to an absent requested file',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'cavi-track-publication-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const host=new exporter.MacAudioExportHost({platform:'darwin'}),path=join(root,'Chosen.wav');
 const frames=4800,data=Buffer.alloc(44+frames*4);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(192000,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(frames*4,40);
 let nativePath;host.renderOwned=async(app,settings,destination,{beforeExport,beforeSave})=>{
   await beforeExport();await beforeSave();nativePath=join(destination.parent.path,destination.name.replace(/\.wav$/,'')+' Render part.wav');await writeFile(nativePath,data);
   return {exportRequested:true,uiComplete:true,trackSelectionVerified:true,renderedTarget:settings.renderTarget};
 };
 const destination=await host.destination(path),settings={sampleRate:48000,bitDepth:16,renderTarget:{trackId:'track-2',name:'Render part'}};
 const result=await host.render('/Live.app',settings,destination,{beforeExport:async()=>{},beforeSave:async()=>{}});
 assert.deepEqual(await readFile(path),data);assert.notEqual(nativePath,join(root,'Chosen Render part.wav'));assert.equal(result.publicationVerified,true);
 const evidence=await host.verify(destination,settings);assert.equal(evidence.durationSeconds,.1);
 const another=await host.destination(join(root,'Conflict.wav'));
 host.renderOwned=async(app,s,d,hooks)=>{await hooks.beforeExport();await hooks.beforeSave();await writeFile(join(d.parent.path,'audio Render part.wav'),data);await writeFile(another.path,'manual file');return {exportRequested:true,uiComplete:true,trackSelectionVerified:true,renderedTarget:s.renderTarget};};
 const conflict=await host.render('/Live.app',settings,another,{beforeExport:async()=>{},beforeSave:async()=>{}});
 assert.equal(conflict.publicationVerified,false);assert.equal(await readFile(another.path,'utf8'),'manual file');assert.ok(conflict.stagingDirectory);
});

test('cancellation during staging verification retains the WAV and does not publish',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'cavi-track-abort-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const host=new exporter.MacAudioExportHost({platform:'darwin'}),path=join(root,'Cancelled.wav'),controller=new AbortController();
 const frames=4800,data=Buffer.alloc(44+frames*4);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(192000,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(frames*4,40);
 const verify=host.verify.bind(host);host.verify=async(...args)=>{const evidence=await verify(...args);controller.abort();return evidence;};
 host.renderOwned=async(app,settings,destination,hooks)=>{await hooks.beforeExport();await hooks.beforeSave();await writeFile(join(destination.parent.path,'audio Part.wav'),data);return {exportRequested:true,uiComplete:true,trackSelectionVerified:true,renderedTarget:settings.renderTarget};};
 const result=await host.render('/Live.app',{sampleRate:48000,bitDepth:16,renderTarget:{trackId:'track-2',name:'Part'}},await host.destination(path),{beforeExport:async()=>{},beforeSave:async()=>{},signal:controller.signal});
 assert.equal(result.publicationVerified,false);await assert.rejects(readFile(path),{code:'ENOENT'});assert.deepEqual(await readFile(join(result.stagingDirectory,'audio Part.wav')),data);
});
