import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {mkdtemp,mkdir,writeFile,realpath,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import vm from "node:vm";
import {MacAudioExportHost} from "../src/audio-export.mjs";
import {ToolService} from "../src/tool-service.mjs";
import {validateToolResult} from "../src/tool-validation.mjs";

const source=readFileSync(new URL("../src/live-audio-export-dialog.js",import.meta.url),"utf8");
const array=items=>({count:items.length,objectAtIndex:i=>items[i]});

// Live's accessibility tree with either a leftover Export dialog or a save-changes sheet.
function nativeLive(scene){
  const standard={AXRole:"AXWindow",AXTitle:"Mix",AXSubrole:"AXStandardWindow",AXDocument:"file:///Mix.als"};
  let windows;
  const button=(identifier,title,close)=>({AXRole:"AXButton",AXIdentifier:identifier,AXTitle:title,AXEnabled:true,press:close});
  const exporting={AXRole:"AXWindow",AXTitle:"Export Audio/Video",AXSubrole:"AXDialog",AXChildren:array([
    button("Base.FinalButtonsBox.CancelButton","Cancel",()=>{windows=windows.filter(w=>w!==exporting);}),
    button("Base.FinalButtonsBox.ExportButton","Export")])};
  const answer=name=>({AXRole:"AXButton",AXDescription:name,AXEnabled:true});
  const sheet={AXRole:"AXSheet",AXChildren:array([{AXRole:"AXStaticText",AXValue:"Save changes to Mix before closing?"},answer("Don't Save"),answer("Cancel"),answer("Save")])};
  // The focused window is a second reference to the same Export window, so the window list and the focused window both report it.
  const focusedCopy={...exporting};
  if(scene==="export"||scene==="exportTwice")windows=[exporting,standard];
  else{standard.AXSheets=array([sheet]);standard.AXChildren=array([sheet]);windows=[standard];}
  const numbers=new Map([[exporting,123],[standard,125]]);
  const app={get AXWindows(){return array(windows);},get AXFocusedWindow(){return scene==="exportTwice"?focusedCopy:undefined;}};
  const native=Object.assign(value=>value,{
    NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>({activateWithOptions(){}})},
    AXUIElementCreateApplication:()=>app,
    AXUIElementCopyAttributeValue:(element,key,ref)=>{if(element[key]===undefined)return -25212;ref[0]=element[key];return 0;},
    AXUIElementPerformAction:element=>{element.press?.();return 0;},
    CFEqual:(a,b)=>a===b,
    // Behind another app Live's windows are offscreen and their titles unreadable.
    CGWindowListCopyWindowInfo:()=>windows.map(w=>({kCGWindowOwnerPID:42,kCGWindowName:focus.behind?undefined:w.AXTitle,kCGWindowNumber:numbers.get(w),kCGWindowIsOnscreen:!focus.behind}))
  });
  const events={applicationProcesses:{whose:()=>()=>[{bundleIdentifier:()=>"com.ableton.live",frontmost:()=>true}]},keystroke(){throw Error("no key may be sent");}};
  return vm.runInNewContext(`${source}\nrun`,{Application:()=>events,$:native,Ref:()=>[],delay(){},
    ObjC:{import(){},unwrap:value=>value,deepUnwrap:value=>value,castRefToObject:value=>value}});
}

// An unsaved Set: Export hides its dialog and the Save panel opens only after the Export press stopped
// waiting for it. Cancelling that panel makes Live show Export Audio/Video again a moment later.
function lateSavePanel(leftover){
  const fields=[["Base.RenderedTrack","Main"],["Base.SampleRateBox.SampleRate","48000"],["Base.FileTypeBox.FileType","WAV"],
    ["Base.FileTypeOptionsBox.FileTypeOptionsCardView.BitDepthBox.BitDepth","24"],["Base.FileTypeOptionsBox.FileTypeOptionsCardView.DitherTypeBox.DitherType","No Dither"],
    ["Base.EncodePcmBox.EncodePcm","On"],["Base.EncodeMp3Box.EncodeMp3","Off"],["Base.AnalysisFileBox.CreateAnalysisFile","Off"],
    ["Base.ConvertToMonoBox.ConvertToMono","Off"],["Base.NormalizeBox.Normalize","Off"],["Base.RenderAsLoopBox.RenderAsLoop","Off"],
    ["Base.RenderStemsBox.RenderStems","Off"],["Base.VideoOptionsCardView.CreateVideoBox.CreateVideo","Off"]];
  for(const [i,part] of ["Bars","Beats","Subdivisions"].entries())fields.push([`Base.RenderStartBox.RenderStart.${part}`,1],[`Base.RenderLengthBox.RenderLength.${part}`,i===0?4:0]);
  let windows,saveOpening=false,reshow=0;
  const standard={AXRole:"AXWindow",AXTitle:"Untitled",AXSubrole:"AXStandardWindow"};
  const exporting={AXRole:"AXWindow",AXTitle:"Export Audio/Video",AXSubrole:"AXDialog",AXChildren:array([
    ...fields.map(([id,value])=>({AXIdentifier:id,AXValue:value,AXEnabled:true})),
    {AXRole:"AXButton",AXIdentifier:"Base.FinalButtonsBox.ExportButton",AXTitle:"Export",AXEnabled:true,press:()=>{windows=[standard];saveOpening=true;}},
    {AXRole:"AXButton",AXIdentifier:"Base.FinalButtonsBox.CancelButton",AXTitle:"Cancel",AXEnabled:true,press:()=>{windows=[standard];}}])};
  const saving={AXRole:"AXWindow",AXTitle:"Save",AXSubrole:"AXDialog",AXIdentifier:"save-panel",AXModal:true,AXChildren:array([
    {AXRole:"AXStaticText",AXIdentifier:"_messageTextField",AXValue:"Save Audio File As:"},
    {AXRole:"AXButton",AXIdentifier:"CancelButton",AXTitle:"Cancel",AXEnabled:true,press:()=>{windows=[standard];reshow=5;}}])};
  windows=leftover?[saving,standard]:[standard];
  const numbers=new Map([[exporting,123],[saving,124],[standard,125]]);
  const app={get AXWindows(){return array(windows);}};
  const native=Object.assign(value=>value,{
    NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>({activateWithOptions(){}})},
    AXUIElementCreateApplication:()=>app,AXUIElementCreateSystemWide:()=>({}),AXUIElementSetMessagingTimeout:()=>0,
    AXUIElementCopyAttributeValue:(element,key,ref)=>{if(element[key]===undefined)return -25212;ref[0]=element[key];return 0;},
    AXUIElementSetAttributeValue:(element,key,value)=>{element[key]=value;return 0;},
    AXUIElementPerformAction:element=>{element.press?.();return 0;},
    CFEqual:(a,b)=>a===b,
    CGWindowListCopyWindowInfo:()=>windows.map(w=>({kCGWindowOwnerPID:42,kCGWindowName:w.AXTitle,kCGWindowNumber:numbers.get(w),kCGWindowIsOnscreen:true}))
  });
  const events={applicationProcesses:{whose:()=>()=>[{bundleIdentifier:()=>"com.ableton.live",frontmost:()=>true}]},
    keystroke:()=>{windows=[exporting,standard];},keyCode:key=>{assert.equal(key,36);windows=[standard];saveOpening=true;}};
  const script=vm.runInNewContext(`${source}\nrun`,{Application:()=>events,$:native,Ref:()=>[],
    delay(){if(reshow&&--reshow===0)windows=[exporting,standard];},
    ObjC:{import(){},unwrap:value=>value,deepUnwrap:value=>value,castRefToObject:value=>value}});
  return argv=>{
    if(saveOpening){saveOpening=false;windows=[saving,standard];}
    if(reshow){reshow=0;windows=[exporting,standard];}
    return script(argv);
  };
}

async function serviceFor(t,scene){
  const directory=await realpath(await mkdtemp(join(tmpdir(),"cavi-dialog-")));t.after(()=>rm(directory,{recursive:true,force:true}));
  const app=join(directory,"Live.app");await mkdir(join(app,"Contents/MacOS"),{recursive:true});await writeFile(join(app,"Contents/MacOS/Live"),"binary");
  focus.behind=scene==="exportBehind";focus.restored=[];
  const run=scene==="lateSave"||scene==="leftoverSave"?lateSavePanel(scene==="leftoverSave"):nativeLive(scene==="exportBehind"?"export":scene),liveSetHost={runningProcesses:async()=>[{pid:42,path:app+"/Contents/MacOS/Live"}],appPathFor:()=>app};
  const execute=async(command,args)=>{
    if(command==="/usr/bin/open")return {stdout:""};
    if(args[2].endsWith("live-app-focus.js")&&scene!=="exportBehind")return {stdout:JSON.stringify({focused:true})};
    if(args[2].endsWith("live-app-focus.js")){
      // Another app (pid 77) is in front until Live is activated; restore puts it back in front.
      const input=JSON.parse(args.at(-1));
      if(input.action==="restore"){focus.behind=true;focus.restored.push(input.restorePid);return {stdout:JSON.stringify({restored:true,activations:1,frontmost:{pid:input.restorePid,name:"Viewer"}})};}
      const previous=focus.behind?{pid:77,name:"Viewer"}:{pid:42,name:"Live"};focus.behind=false;
      return {stdout:JSON.stringify({focused:true,activations:1,previous})};
    }
    if(!args[2].endsWith("live-audio-export-dialog.js"))throw Error("unexpected native script");
    return {stdout:run([args.at(-1)])};
  };
  const bridge={request:async()=>({stateVersion:3,setFingerprint:"set",identityToken:"document"})};
  return {directory,service:new ToolService({liveSetHost,bridge,audioExportHost:new MacAudioExportHost({platform:"darwin",liveSetHost,execute})})};
}

const focus={behind:false,restored:[]};

test("an export dialog behind another app is cancelled with Live in front and focus given back",async t=>{
  const {service}=await serviceFor(t,"exportBehind");
  const state=validateToolResult("get_live_dialog_state",await service.call("get_live_dialog_state",{}),{});
  assert.deepEqual(state.dialogs.map(d=>[d.identity,d.sheet,d.windowId]),[["exportAudioVideo",false,null]]);
  const plan=validateToolResult("cancel_live_export_dialog",await service.call("cancel_live_export_dialog",{}),{});
  assert.deepEqual(plan.plan.targets.map(d=>[d.identity,d.windowId]),[["exportAudioVideo",null]]);
  const execute={dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  const result=validateToolResult("cancel_live_export_dialog",await service.call("cancel_live_export_dialog",execute),execute);
  assert.equal(result.cancelled,true);assert.equal(result.blocked,false);assert.equal(result.pendingUserAction,false);
  assert.deepEqual(result.closed.map(d=>[d.identity,d.windowId]),[["exportAudioVideo",123]]);
  assert.deepEqual(result.focus,{activations:1,before:"Viewer",returned:true,returnedTo:"Viewer"});
  assert.deepEqual(focus.restored,[77]);
  assert.deepEqual((await service.call("get_live_dialog_state",{})).dialogs,[]);
});

test("an export dialog planned in front and confirmed behind another app is cancelled",async t=>{
  const {service}=await serviceFor(t,"exportBehind");focus.behind=false;
  const plan=validateToolResult("cancel_live_export_dialog",await service.call("cancel_live_export_dialog",{}),{});
  assert.deepEqual(plan.plan.targets.map(d=>[d.identity,d.windowId]),[["exportAudioVideo",123]]);
  focus.behind=true;
  const execute={dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  const result=validateToolResult("cancel_live_export_dialog",await service.call("cancel_live_export_dialog",execute),execute);
  assert.equal(result.cancelled,true);assert.equal(result.blocked,false);
  assert.deepEqual(result.closed.map(d=>[d.identity,d.windowId]),[["exportAudioVideo",123]]);
  assert.deepEqual(focus.restored,[77]);
  assert.deepEqual((await service.call("get_live_dialog_state",{})).dialogs,[]);
});

test("one Export Audio/Video window listed twice is one dialog and its cancel is planned",async t=>{
  const {service}=await serviceFor(t,"exportTwice");
  const state=await service.call("get_live_dialog_state",{});
  assert.deepEqual(state.dialogs.map(d=>[d.identity,d.windowId]),[["exportAudioVideo",123]]);
  const plan=validateToolResult("cancel_live_export_dialog",await service.call("cancel_live_export_dialog",{}),{});
  assert.equal(plan.dryRun,true);assert.equal(plan.plan.targets.length,1);
});

const saveChanges=[{identity:"unknown",sheet:true,parentTitle:"Mix",modal:false,buttons:["Don't Save","Cancel","Save"]}];
const identity=dialogs=>dialogs.map(({identity,sheet,parentTitle,modal,buttons})=>({identity,sheet,parentTitle,modal,buttons}));

test("a leftover Export Audio/Video dialog is identified and cancelled without an owning call",async t=>{
  const {service}=await serviceFor(t,"export");
  const state=validateToolResult("get_live_dialog_state",await service.call("get_live_dialog_state",{}),{});
  assert.equal(state.blocked,true);
  assert.deepEqual(state.dialogs.map(d=>[d.identity,d.title,d.subrole,d.windowId,d.buttons]),[["exportAudioVideo","Export Audio/Video","AXDialog",123,["Cancel","Export"]]]);
  const plan=validateToolResult("cancel_live_export_dialog",await service.call("cancel_live_export_dialog",{}),{});
  assert.equal(plan.dryRun,true);assert.equal((await service.call("get_live_dialog_state",{})).blocked,true);
  const execute={dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  const result=validateToolResult("cancel_live_export_dialog",await service.call("cancel_live_export_dialog",execute),execute);
  assert.equal(result.cancelled,true);assert.equal(result.blocked,false);assert.equal(result.operationOutcome.status,"applied");
  assert.deepEqual((await service.call("get_live_dialog_state",{})).dialogs,[]);
});

test("a save-changes sheet is refused with its identity and left unanswered",async t=>{
  const {service}=await serviceFor(t,"saveChanges");
  await assert.rejects(service.call("cancel_live_export_dialog",{}),error=>{
    assert.equal(error.code,"NATIVE_DIALOG_REFUSED");assert.deepEqual(identity(error.blockingDialogs),saveChanges);return true;});
  assert.deepEqual(identity((await service.call("get_live_dialog_state",{})).dialogs),saveChanges);
});

test("an export blocked by an existing dialog returns the blocker identity as structured fields",async t=>{
  const {directory,service}=await serviceFor(t,"saveChanges");
  const args={path:join(directory,"Mix.wav"),start:"1.1.1",length:"4.0.0",expectedStateVersion:3,expectedSetFingerprint:"set"};
  const plan=await service.call("export_audio_mix",args);
  const execute={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  const result=validateToolResult("export_audio_mix",await service.call("export_audio_mix",execute),execute);
  assert.equal(result.exportRequested,false);assert.equal(result.pendingUserAction,true);
  assert.deepEqual(identity(result.blockingDialogs),saveChanges);
});

test("an Export press whose Save panel opens late leaves an unsaved Set with no dialog",async t=>{
  const {directory,service}=await serviceFor(t,"lateSave");
  const args={path:join(directory,"Mix.wav"),start:"1.1.1",length:"4.0.0",expectedStateVersion:3,expectedSetFingerprint:"set"};
  const plan=await service.call("export_audio_mix",args);
  const execute={...args,dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  const result=validateToolResult("export_audio_mix",await service.call("export_audio_mix",execute),execute);
  assert.match(result.limitation,/Save panel did not appear/);assert.doesNotMatch(result.limitation,/cleanup unverified/);
  assert.equal(result.exportRequested,false);assert.equal(result.pendingUserAction,false);assert.equal(result.blockingDialogs,undefined);
  const state=await service.call("get_live_dialog_state",{});
  assert.deepEqual(state.dialogs,[]);assert.equal(state.uiComplete,true);
});

test("cancelling a leftover export Save panel also cancels the Export dialog Live shows again",async t=>{
  const {service}=await serviceFor(t,"leftoverSave");
  const plan=await service.call("cancel_live_export_dialog",{});
  assert.deepEqual(plan.plan.targets.map(d=>d.identity),["exportSavePanel"]);
  const execute={dryRun:false,confirmationToken:plan.confirmation.token,planHash:plan.confirmation.planHash};
  const result=validateToolResult("cancel_live_export_dialog",await service.call("cancel_live_export_dialog",execute),execute);
  assert.deepEqual(result.closed.map(d=>[d.identity,d.windowId]),[["exportSavePanel",124],["exportAudioVideo",123]]);
  assert.equal(result.blocked,false);assert.equal(result.pendingUserAction,false);
  assert.deepEqual((await service.call("get_live_dialog_state",{})).dialogs,[]);
});
