import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,symlink,rm,realpath,mkdir} from "node:fs/promises";
import {readFileSync,writeFileSync,existsSync,statSync} from "node:fs";
import {join,basename} from "node:path";
import {tmpdir} from "node:os";
import vm from "node:vm";
import {MacAudioExportHost,exportAudioMix,exportSettings} from "../src/audio-export.mjs";
import {ConfirmationStore} from "../src/confirmation-store.mjs";

const exportSource=readFileSync(new URL("../src/live-audio-export-dialog.js",import.meta.url),"utf8");
const saveSource=readFileSync(new URL("../src/live-set-save-dialog.js",import.meta.url),"utf8");

// Accessibility snapshot of Live behind another app (pid 7), driven by the real dialog and focus scripts.
// The window stays where it is. onscreen false means the focus check refuses before any press.
// nameDrifts: the filename field reads differently after its first readback.
function backgroundLive({panelFolder,appPath,rangeSettable=true,onscreen=true,saveEnabled=true,nameDrifts=false}){
  const keys=[],presses=[],dockPresses=[],array=list=>({count:list.length,objectAtIndex:i=>list[i]});
  let front=7,activations=0,typed="",focus=null;
  const isLive=()=>front===42;
  const node=(attributes,kids=[])=>({AXChildren:array(kids),...attributes});
  const fields={track:["Base.RenderedTrack","Main"],rate:["Base.SampleRateBox.SampleRate","48000"],type:["Base.FileTypeBox.FileType","WAV"],
    bits:["Base.FileTypeOptionsBox.FileTypeOptionsCardView.BitDepthBox.BitDepth","24"],dither:["Base.FileTypeOptionsBox.FileTypeOptionsCardView.DitherTypeBox.DitherType","No Dither"],
    pcm:["Base.EncodePcmBox.EncodePcm","On"],mp3:["Base.EncodeMp3Box.EncodeMp3","Off"],analysis:["Base.AnalysisFileBox.CreateAnalysisFile","Off"],
    mono:["Base.ConvertToMonoBox.ConvertToMono","Off"],normalize:["Base.NormalizeBox.Normalize","Off"],loop:["Base.RenderAsLoopBox.RenderAsLoop","Off"],
    returns:["Base.RenderStemsBox.RenderStems","Off"],video:["Base.VideoOptionsCardView.CreateVideoBox.CreateVideo","Off"]};
  ["Bars","Beats","Subdivisions"].forEach((part,i)=>{fields[`start${i}`]=[`Base.RenderStartBox.RenderStart.${part}`,1];fields[`length${i}`]=[`Base.RenderLengthBox.RenderLength.${part}`,i===0?8:0];});
  const controls=Object.values(fields).map(([id,value])=>node({AXIdentifier:id,AXValue:value,AXEnabled:true,range:/Render(Start|Length)/u.test(id)}));
  const exportButton=node({AXIdentifier:"Base.FinalButtonsBox.ExportButton",AXRole:"AXButton",AXEnabled:true});
  const exportCancel=node({AXIdentifier:"Base.FinalButtonsBox.CancelButton",AXRole:"AXButton",AXEnabled:true});
  const exportWindow=node({AXTitle:"Export Audio/Video",AXSubrole:"AXDialog",AXRole:"AXWindow"},[...controls,exportButton,exportCancel]);
  const main=node({AXTitle:"Set",AXSubrole:"AXStandardWindow",AXRole:"AXWindow"});
  const folder=node({AXURL:{isFileURL:true,hasDirectoryPath:true,filePathURL:{path:panelFolder}}});
  const browser=node({AXIdentifier:"ColumnView",AXRole:"AXBrowser",AXColumns:array([node({},[node({AXRole:"AXList",AXSelectedChildren:array([node({},[folder])])})]),node({})])});
  const nameField=node({AXIdentifier:"saveAsNameTextField",AXRole:"AXTextField",AXValue:"Untitled.wav"});
  const saveButton=node({AXIdentifier:"OKButton",AXRole:"AXButton",AXEnabled:true,AXTitle:"Save"});
  const saveCancel=node({AXIdentifier:"CancelButton",AXRole:"AXButton",AXEnabled:true,AXTitle:"Cancel"});
  const savePanel=node({AXTitle:"Save",AXIdentifier:"save-panel",AXModal:true,AXSubrole:"AXDialog",AXRole:"AXWindow"},
    [node({AXIdentifier:"_messageTextField",AXRole:"AXStaticText",AXValue:"Save Audio File As:"}),nameField,browser,saveButton,saveCancel]);
  Object.defineProperty(saveButton,"AXEnabled",{get:()=>saveEnabled});
  if(nameDrifts){let stored=nameField.AXValue,reads=0;Object.defineProperty(nameField,"AXValue",{get(){return reads++>1&&stored!=="Untitled.wav"?stored.replace(/\.wav$/u,""):stored;},set(value){stored=value;reads=0;}});}
  const exportItem=node({AXTitle:"Export Audio/Video...",AXRole:"AXMenuItem",AXEnabled:true});
  const numbers=new Map([[main,100],[exportWindow,123],[savePanel,124]]);
  let open=[main];
  const app={get AXWindows(){return array(open);},get AXFocusedWindow(){return open[0];},get AXMainWindow(){return main;},get AXFrontmost(){return isLive();},
    AXMenuBar:node({},[node({AXTitle:"File"},[node({AXRole:"AXMenu"},[exportItem])])])};
  const dockItem={AXSubrole:"AXApplicationDockItem",AXURL:{path:appPath}},dockRoot={AXChildren:array([{AXChildren:array([dockItem])}])};
  const apps={42:{name:"Live",bundle:"com.ableton.live",path:appPath},7:{name:"Editor",bundle:"com.example.editor",path:"/Applications/Editor.app"}};
  const running=pid=>apps[pid]&&{processIdentifier:pid,localizedName:apps[pid].name,bundleIdentifier:apps[pid].bundle,bundleURL:{path:apps[pid].path},
    activateWithOptions(){activations++;return true;}};
  // Export and Save hold their AXPress reply while Live runs the Save panel or renders. A disabled Save does nothing.
  const perform=(element,action)=>{
    if(element===dockItem){dockPresses.push("Live");return -25204;}
    if(action!=="AXPress")return -25206;
    presses.push(element.AXIdentifier??element.AXTitle);
    if(element===exportItem)open=[exportWindow,main];
    else if(element===exportButton){open=[savePanel,main];return -25204;}
    else if(element===saveButton){if(saveButton.AXEnabled!==true)return 0;writeFileSync(join(panelFolder,nameField.AXValue),Buffer.alloc(4096,1));open=[main];return -25204;}
    else if(element===saveCancel)open=[exportWindow,main];
    else if(element===exportCancel)open=[main];
    return 0;
  };
  const native=Object.assign(value=>value,{
    AXUIElementCreateApplication:pid=>pid===42?app:pid===9?dockRoot:{get AXFrontmost(){return front===pid;}},AXUIElementCreateSystemWide:()=>({}),AXUIElementSetMessagingTimeout:()=>0,
    AXUIElementCopyAttributeValue:(element,key,ref)=>{if(element[key]===undefined)return -25212;ref[0]=element[key];return 0;},
    AXUIElementSetAttributeValue:(element,key,value)=>{
      if(key==="AXFocused"){element.AXFocused=value;focus=element;return 0;}
      if(key==="AXValue"&&element.range&&!rangeSettable)return -25205;
      element[key]=element.range?Number(value):value;return 0;
    },
    AXUIElementPerformAction:perform,CFEqual:(a,b)=>a===b,
    CGWindowListCopyWindowInfo:()=>open.map(w=>({kCGWindowOwnerPID:42,kCGWindowName:w.AXTitle,kCGWindowNumber:numbers.get(w),kCGWindowIsOnscreen:onscreen,kCGWindowLayer:0})),
    NSRunningApplication:{runningApplicationWithProcessIdentifier:running,runningApplicationsWithBundleIdentifier:()=>array([{processIdentifier:9}])},
    NSWorkspace:{sharedWorkspace:{get frontmostApplication(){return running(front);}}},
    NSFileManager:{defaultManager:{
      attributesOfItemAtPathError:path=>{const info=statSync(path,{bigint:true});return {objectForKey:key=>({stringValue:String(key==="NSFileSystemNumber"?info.dev:info.ino)})};},
      destinationOfSymbolicLinkAtPathError:()=>null,fileExistsAtPath:path=>existsSync(path)}}
  });
  const liveProcess={bundleIdentifier:()=>"com.ableton.live",frontmost:isLive,windows:()=>[]};
  const events={applicationProcesses:{whose:()=>()=>[liveProcess]},
    keystroke:text=>{keys.push(text);if(isLive())typed=text;},
    keyCode:code=>{keys.push(code);if(!isLive()||code!==36)return;if(focus?.range)focus.AXValue=Number(typed);else if(focus===exportButton)open=[savePanel,main];}};
  const context=()=>({Application:()=>events,$:native,Ref:()=>[],delay(){},ObjC:{import(){},unwrap:value=>value,deepUnwrap:value=>value,castRefToObject:value=>value}});
  const focusSource=readFileSync(new URL("../src/live-app-focus.js",import.meta.url),"utf8");
  const scripts={export:vm.runInNewContext(`${exportSource}\nrun`,context()),save:vm.runInNewContext(`${saveSource}\nrun`,context()),focus:vm.runInNewContext(`${focusSource}\nrun`,context())};
  return {keys,presses,dockPresses,get activations(){return activations;},get front(){return front;},get open(){return open.map(w=>w.AXTitle);},
    run:(script,input)=>(script.endsWith("live-set-save-dialog.js")?scripts.save:script.endsWith("live-app-focus.js")?scripts.focus:scripts.export)([input])};
}

async function backgroundExport(t,{panelElsewhere=false,...options}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),"cavi-export-ax-")));t.after(()=>rm(root,{recursive:true,force:true}));
  const requested=join(root,"requested"),other=join(root,"other"),app=join(root,"Live.app");
  await mkdir(requested);await mkdir(other);await mkdir(join(app,"Contents/MacOS"),{recursive:true});await writeFile(join(app,"Contents/MacOS/Live"),"binary");
  const live=backgroundLive({panelFolder:panelElsewhere?other:requested,appPath:app,...options}),commands=[];
  const host=new MacAudioExportHost({platform:"darwin",renderTimeoutMs:5000,
    liveSetHost:{appPathFor:()=>app,runningProcesses:async()=>[{pid:42,path:join(app,"Contents/MacOS/Live")}]},
    execute:async(command,args)=>{
      commands.push(command==="/usr/bin/osascript"?basename(args[2]):command);
      if(command==="ffprobe")return {stdout:JSON.stringify({format:{format_name:"wav",duration:"142.222"},streams:[{codec_type:"audio",codec_name:"pcm_s24le",sample_rate:"48000",channels:2,bits_per_sample:24}]})};
      if(command!=="/usr/bin/osascript")throw Error(`unexpected command ${command}`);
      return {stdout:live.run(args[2],args[3])};
    }});
  const bridge={request:async()=>({stateVersion:3,setFingerprint:"set",identityToken:"document"})},store=new ConfirmationStore();
  const args={path:join(requested,"Mix.wav"),start:"1.1.1",length:"64.0.0",expectedStateVersion:3,expectedSetFingerprint:"set"};
  const plan=await exportAudioMix(bridge,store,host,args);
  const result=await exportAudioMix(bridge,store,host,{...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash});
  return {result,live,commands,requested,other};
}

test("audio export leaves Live where it is and completes through accessibility",async t=>{
  const {result,live,commands,requested}=await backgroundExport(t);
  assert.equal(result.artifactVerified,true);assert.equal(result.evidence.path,join(requested,"Mix.wav"));assert.equal(result.evidence.durationSeconds,142.222);
  assert.equal(result.exportPress.path,"accessibility");
  assert.deepEqual(result.exportPress.steps,{open:"menu",range:"axValue",export:"axPress",folder:"panel",save:"axPress"});
  assert.deepEqual(result.exportPress.focus,{before:"Editor",activations:0,returned:true,returnedTo:"Editor"});
  assert.deepEqual(result.exportPress.keys,[]);assert.equal(result.exportPress.activations,0);assert.equal(result.relocation,undefined);
  assert.deepEqual(live.keys,[]);assert.equal(live.activations,0);assert.equal(live.front,7);assert.deepEqual(live.open,["Set"]);
  assert.deepEqual(live.dockPresses,[]);
  assert.equal(commands.filter(command=>command==="live-app-focus.js").length,1);assert.ok(!commands.includes("/usr/bin/open"));
});

test("audio export presses nothing when Live's window is not on screen",async t=>{
  const {result,live,requested}=await backgroundExport(t,{onscreen:false});
  assert.equal(result.exportVerified,false);assert.equal(result.exportRequested,false);assert.equal(result.retrySafe,true);
  assert.match(result.limitation,/not on screen/);
  assert.equal(result.exportPress.focus.activations,0);
  assert.deepEqual(live.presses,[]);assert.deepEqual(live.keys,[]);assert.deepEqual(live.dockPresses,[]);
  assert.equal(live.front,7);assert.equal(existsSync(join(requested,"Mix.wav")),false);
});

test("audio export sends no key when a coordinate has no accessibility value",async t=>{
  const {result,live}=await backgroundExport(t,{rangeSettable:false});
  assert.equal(result.exportRequested,false);
  assert.match(result.limitation,/no key was sent/);
  assert.deepEqual(live.keys,[]);assert.equal(live.activations,0);assert.equal(live.front,7);
});

test("audio export whose Save is disabled closes its own dialogs without raising Live",async t=>{
  const {result,live,requested}=await backgroundExport(t,{saveEnabled:false});
  assert.equal(result.exportVerified,false);assert.equal(result.exportRequested,false);assert.equal(result.retrySafe,true);assert.equal(result.pendingUserAction,false);
  assert.match(result.limitation,/Save is disabled/);
  assert.ok(!live.presses.includes("OKButton"));assert.deepEqual(live.open,["Set"]);
  assert.equal(live.activations,0);assert.equal(live.front,7);assert.deepEqual(live.keys,[]);
  assert.equal(existsSync(join(requested,"Mix.wav")),false);
});

test("a Save panel showing another folder saves there and the verified file moves to the requested path",async t=>{
  const {result,live,requested,other}=await backgroundExport(t,{panelElsewhere:true});
  assert.equal(result.artifactVerified,true);assert.equal(result.exportPress.path,"accessibility");assert.deepEqual(live.keys,[]);
  assert.equal(result.relocation.moved,true);assert.equal(result.relocation.method,"link");
  assert.equal(result.relocation.from,join(other,"Mix.wav"));assert.equal(result.relocation.to,join(requested,"Mix.wav"));
  assert.equal(result.relocation.sha256,result.evidence.sha256);
  assert.equal(existsSync(join(other,"Mix.wav")),false);assert.equal(existsSync(join(requested,"Mix.wav")),true);
});

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
    if(!save&&input.action==="inspect")return {stdout:JSON.stringify({blocked:false,dialogs:[]})};
    throw Error("unexpected native action");
  }});
  let failure;try{await host.render(app,{},{path:join(directory,"Mix.wav"),parent:{path:directory},name:"Mix.wav"},{beforeExport:async()=>{},beforeSave:async()=>{if(!unknownSave)throw Error("mix changed");}});}catch(error){failure=error;}
  assert.ok(failure);
  if(unknownSave){assert.equal(failure.exportRequested,null);assert.notEqual(failure.retrySafe,true);assert.ok(!calls.some(([,action])=>action==="cancel"));}
  else{assert.equal(failure.exportRequested,false);assert.equal(failure.dialogCleanup.cancelled,true);assert.equal(failure.retrySafe,true);assert.deepEqual(calls.slice(-3),[["save","cancel"],["export","cancel"],["export","inspect"]]);}
});

for(const left of [[],[{identity:"unknown",title:"Alert"}]])test(`a lost Export press ${left.length?"with a dialog left is not safe to retry":"with Live clear is safe to retry"}`,async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"cavi-export-lost-")));t.after(()=>rm(directory,{recursive:true,force:true}));
  const app=join(directory,"Live.app");await mkdir(join(app,"Contents/MacOS"),{recursive:true});await writeFile(join(app,"Contents/MacOS/Live"),"binary");
  const exportPress={focusReasserted:0,liveFrontmostAfterKey:false,frontmostAfterKey:"com.apple.Safari",afterWait:{exportDialogListed:true,dialogs:[]}};
  const host=new MacAudioExportHost({platform:"darwin",liveSetHost:{runningProcesses:async()=>[{pid:42,path:app+"/Contents/MacOS/Live"}]},execute:async(command,args)=>{
    if(command==="/usr/bin/open")return {stdout:""};if(args[2].endsWith("live-app-focus.js"))return {stdout:JSON.stringify({focused:true})};const input=JSON.parse(args.at(-1));
    if(input.action==="prepare")return {stdout:JSON.stringify({prepared:true,windowId:1,panelState:{track:"Main"}})};
    if(input.action==="commit")return {stdout:JSON.stringify({exportPressed:true,error:"Native audio Save panel did not appear",exportPress})};
    if(input.action==="cancel")return {stdout:JSON.stringify({cancelled:true})};
    if(input.action==="inspect")return {stdout:JSON.stringify({blocked:left.length>0,dialogs:left})};
    throw Error("unexpected native action");
  }});
  const failure=await host.render(app,{},{path:join(directory,"Mix.wav"),parent:{path:directory},name:"Mix.wav"},{beforeExport:async()=>{},beforeSave:async()=>{}}).catch(error=>error);
  assert.equal(failure.exportRequested,false);assert.equal(failure.dialogCleanup.cancelled,true);
  assert.equal(failure.retrySafe,left.length===0);assert.deepEqual(failure.exportPress.observed["export.commit"],exportPress);
});
