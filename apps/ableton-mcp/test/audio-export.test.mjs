import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,symlink,rm,realpath,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {MacAudioExportHost,exportAudioMix,exportSettings} from "../src/audio-export.mjs";
import {ConfirmationStore} from "../src/confirmation-store.mjs";

test("export settings preserve native musical coordinates and require a positive length",()=>{
  assert.deepEqual(exportSettings({start:"9.1.1",length:"4.0.0",sampleRate:48000,bitDepth:24}),
    {start:[9,1,1],length:[4,0,0],sampleRate:48000,bitDepth:24});
  for(const args of [{start:"0.1.1",length:"1.0.0"},{start:"1.1.1",length:"0.0.0"},
    {start:"1.1.1",length:"1.0.0",sampleRate:123},{start:"1.1.1",length:"1.0.0",bitDepth:8}])assert.throws(()=>exportSettings(args));
});

test("export destinations bind the actual directory and refuse files and symlinks",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"cavi-export-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const host=new MacAudioExportHost({platform:"darwin"}),path=join(directory,"Mix.wav");
  const planned=await host.destination(path);assert.equal(planned.name,"Mix.wav");assert.ok(planned.parent.ino);
  await writeFile(path,"existing");await assert.rejects(host.destination(path),/exists/);
  await symlink(join(directory,"Missing.wav"),join(directory,"Link.wav"));await assert.rejects(host.destination(join(directory,"Link.wav")),/exists/);
  await assert.rejects(host.destination(join(directory,"Hidden/.mix.wav")),/filename|directory/);
});

test("export planning has no UI effects and rechecks mix context immediately before rendering",async()=>{
  let volume=0.5,renders=0,ready=0;
  const bridge={request:async()=>({stateVersion:3,setFingerprint:"set",identityToken:"document",mix:{volume}})};
  const host={appPathFor:()=>"/Applications/Live.app",destination:async path=>({path,name:"Mix.wav",parent:{path:"/exports",ino:"1",dev:"2"}}),
    render:async(app,settings,destination,{beforeExport,beforeSave})=>{renders++;await beforeExport();ready++;await beforeSave();return {exportRequested:true,uiComplete:true};},
    verify:async()=>({verified:true,durationSeconds:8,sampleRate:48000,bitDepth:24,channels:2})};
  const store=new ConfirmationStore(),args={path:"/exports/Mix.wav",start:"1.1.1",length:"4.0.0",expectedStateVersion:3,expectedSetFingerprint:"set"};
  const dry=await exportAudioMix(bridge,store,host,args);assert.equal(renders,0);
  volume=0.6;await assert.rejects(exportAudioMix(bridge,store,host,{...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash}),/hash mismatch/);assert.equal(renders,0);
  volume=0.5;const result=await exportAudioMix(bridge,store,host,{...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash});
  assert.equal(result.artifactVerified,true);assert.equal(result.exportVerified,false);assert.equal(result.renderCompletion,"unconfirmed");assert.equal(ready,1);
});

for(const phase of ["confirmation","beforeExport","beforeSave","afterRender"])test(`crossfader membership changes at the same version are detected at ${phase}`,async()=>{
  let assignment="none",renders=0,exports=0,saves=0;
  const bridge={request:async()=>({stateVersion:3,setFingerprint:"set",identityToken:"document",
    crossfader:{identityToken:"native-mixers",tracks:[{trackId:"return-0",assignment:{supported:true,name:assignment}}]}})};
  const host={appPathFor:()=>"/Live.app",destination:async path=>({path}),
    render:async(app,settings,destination,{beforeExport,beforeSave})=>{
      renders++;
      if(phase==="beforeExport")assignment="B";
      await beforeExport();exports++;
      if(phase==="beforeSave")assignment="B";
      await beforeSave();saves++;
      if(phase==="afterRender")assignment="B";
      return {exportRequested:true,uiComplete:true};
    },verify:async()=>({verified:true,durationSeconds:8})};
  const store=new ConfirmationStore(),args={path:"/Mix.wav",start:"1.1.1",length:"4.0.0",expectedStateVersion:3,expectedSetFingerprint:"set"};
  const plan=await exportAudioMix(bridge,store,host,args);
  if(phase==="confirmation")assignment="B";
  const execute=()=>exportAudioMix(bridge,store,host,{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  if(phase==="confirmation"){
    await assert.rejects(execute(),/hash mismatch/);assert.equal(renders,0);
  }else{
    const result=await execute();assert.equal(result.exportVerified,false);assert.equal(renders,1);
    if(phase==="afterRender"){
      assert.equal(result.contextUnchanged,false);assert.equal(result.artifactVerified,true);assert.equal(result.renderCompletion,"unconfirmed");
    }else assert.match(result.limitation,/context changed before render/);
  }
  assert.equal(exports,phase==="confirmation"||phase==="beforeExport"?0:1);
  assert.equal(saves,phase==="afterRender"?1:0);
});

test("a file alone cannot verify an unfinished or unknown native export",async()=>{
  const bridge={request:async()=>({stateVersion:3,setFingerprint:"set",identityToken:"document"})};
  const host={appPathFor:()=>"/Live.app",destination:async path=>({path}),render:async()=>({exportRequested:true,uiComplete:false}),verify:async()=>{throw Error("must not verify while native UI is unresolved");}};
  const store=new ConfirmationStore(),args={path:"/Mix.wav",start:"1.1.1",length:"1.0.0",expectedStateVersion:3,expectedSetFingerprint:"set"},p=await exportAudioMix(bridge,store,host,args);
  const result=await exportAudioMix(bridge,store,host,{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});assert.equal(result.exportVerified,false);assert.equal(result.pendingUserAction,true);
});

test("a valid partial WAV after dialog disappearance does not prove render completion",async()=>{
  const bridge={request:async()=>({stateVersion:3,setFingerprint:"set",identityToken:"document"})};
  const host={appPathFor:()=>"/Live.app",destination:async path=>({path}),render:async()=>({exportRequested:true,uiComplete:true}),verify:async()=>({verified:true,durationSeconds:0.1})};
  const store=new ConfirmationStore(),args={path:"/Mix.wav",start:"1.1.1",length:"4.0.0",expectedStateVersion:3,expectedSetFingerprint:"set"},p=await exportAudioMix(bridge,store,host,args);
  const result=await exportAudioMix(bridge,store,host,{...args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash});assert.equal(result.artifactVerified,true);assert.equal(result.exportVerified,false);
});

test("export readiness retries only refused untransmitted reads, never an unknown request",async()=>{
  for(const outcome of ["not_executed","unknown"]){
    let reads=0;
    const bridge={request:async()=>{reads++;if(reads===1)throw Object.assign(Error("refused"),{code:"BRIDGE_TRANSPORT",outcome});return {stateVersion:3,setFingerprint:"set",identityToken:"document"};}};
    const host={appPathFor:()=>"/Live.app",destination:async path=>({path})};
    const args={path:"/Mix.wav",start:"1.1.1",length:"1.0.0",expectedStateVersion:3,expectedSetFingerprint:"set"};
    if(outcome==="unknown"){await assert.rejects(exportAudioMix(bridge,new ConfirmationStore(),host,args),/refused/);assert.equal(reads,1);}
    else{assert.equal((await exportAudioMix(bridge,new ConfirmationStore(),host,args)).dryRun,true);assert.equal(reads,2);}
  }
});

test("file verification measures real WAV bytes and rejects a different PCM format",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"cavi-export-wav-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,"Mix.wav"),samples=4800,data=Buffer.alloc(44+samples*4);
  data.write("RIFF");data.writeUInt32LE(data.length-8,4);data.write("WAVEfmt ",8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(48000*4,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);data.write("data",36);data.writeUInt32LE(samples*4,40);await writeFile(path,data);
  const host=new MacAudioExportHost({platform:"darwin"}),canonical=await realpath(path),evidence=await host.verify({path:canonical},{sampleRate:48000,bitDepth:16});
  assert.equal(evidence.verified,true);assert.equal(evidence.durationSeconds,0.1);assert.match(evidence.sha256,/^[a-f0-9]{64}$/u);
  await assert.rejects(host.verify({path:canonical},{sampleRate:48000,bitDepth:24}),/does not match/);
});

for(const unknownSave of [false,true])test(`native export ${unknownSave?"preserves an unknown Save outcome":"cleans unchanged dialogs after a pre-Save context failure"}`,async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"cavi-export-app-")));t.after(()=>rm(directory,{recursive:true,force:true}));
  const app=join(directory,"Live.app");await mkdir(join(app,"Contents/MacOS"),{recursive:true});await writeFile(join(app,"Contents/MacOS/Live"),"binary");
  const calls=[],host=new MacAudioExportHost({platform:"darwin",liveSetHost:{runningProcesses:async()=>[{pid:42,path:app+"/Contents/MacOS/Live"}]},execute:async(command,args)=>{
    if(command==="/usr/bin/open")return {stdout:""};if(args[2].endsWith("live-app-focus.js"))return {stdout:JSON.stringify({focused:true})};const input=JSON.parse(args.at(-1)),save=args[2].endsWith("live-set-save-dialog.js");calls.push([save?"save":"export",input.action]);
    if(!save&&input.action==="prepare")return {stdout:JSON.stringify({prepared:true,windowId:1,panelState:{track:"Main"}})};
    if(!save&&input.action==="commit")return {stdout:JSON.stringify({exportPressed:true,saveWindowId:2})};
    if(save&&input.action==="adoptAudioExport")return {stdout:JSON.stringify({prepared:true,windowId:2,purpose:"Save Audio File As:",panelState:{name:"Mix.wav",folder:directory}})};
    if(save&&input.action==="commit")throw Error("Save process outcome unknown");
    if(input.action==="cancel")return {stdout:JSON.stringify({cancelled:true})};
    throw Error("unexpected native action");
  }});
  let failure;try{await host.render(app,{},{parent:{path:directory},name:"Mix.wav"},{beforeExport:async()=>{},beforeSave:async()=>{if(!unknownSave)throw Error("mix changed");}});}catch(error){failure=error;}
  assert.ok(failure);
  if(unknownSave){assert.equal(failure.exportRequested,null);assert.ok(!calls.some(([,action])=>action==="cancel"));}
  else{assert.equal(failure.exportRequested,false);assert.equal(failure.dialogCleanup.cancelled,true);assert.deepEqual(calls.slice(-2),[["save","cancel"],["export","cancel"]]);}
});
