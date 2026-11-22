import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../src/live-audio-export-dialog.js",import.meta.url),"utf8");
function nativeDialog({empty=false,readError=false,focusable=true,focusedOnly=false,loseFocus=false,activations=Infinity,behind=false,pressRefused=false}={}){
  const keys=[],presses=[],array=items=>({count:items.length,objectAtIndex:i=>items[i]});
  const fields={track:["Base.RenderedTrack","Main"],rate:["Base.SampleRateBox.SampleRate","48000"],type:["Base.FileTypeBox.FileType","WAV"],
    bits:["Base.FileTypeOptionsBox.FileTypeOptionsCardView.BitDepthBox.BitDepth","24"],dither:["Base.FileTypeOptionsBox.FileTypeOptionsCardView.DitherTypeBox.DitherType","No Dither"],
    pcm:["Base.EncodePcmBox.EncodePcm","On"],mp3:["Base.EncodeMp3Box.EncodeMp3","Off"],analysis:["Base.AnalysisFileBox.CreateAnalysisFile","Off"],
    mono:["Base.ConvertToMonoBox.ConvertToMono","Off"],normalize:["Base.NormalizeBox.Normalize","Off"],loop:["Base.RenderAsLoopBox.RenderAsLoop","Off"],
    returns:["Base.RenderStemsBox.RenderStems","Off"],video:["Base.VideoOptionsCardView.CreateVideoBox.CreateVideo","Off"]};
  for(const [i,part] of ["Bars","Beats","Subdivisions"].entries()){
    fields[`start${i}`]=[`Base.RenderStartBox.RenderStart.${part}`,1];
    fields[`length${i}`]=[`Base.RenderLengthBox.RenderLength.${part}`,i===0?1:0];
  }
  const controls=Object.values(fields).map(([id,value])=>({AXIdentifier:id,AXValue:value,AXEnabled:true}));
  const button={AXIdentifier:"Base.FinalButtonsBox.ExportButton",AXEnabled:true,AXFocused:false};
  const standard={AXTitle:"Mix",AXSubrole:"AXStandardWindow",AXDocument:"file:///Mix.als"};
  const exporting={AXTitle:"Export Audio/Video",AXSubrole:"AXDialog",AXChildren:array([...controls,button])};
  const saving={AXTitle:"Save",AXIdentifier:"save-panel",AXModal:true};
  let windows=empty?[]:[exporting,standard],focused,frontmost=!behind,activated=0;
  const app={get AXWindows(){return array(windows);},get AXFocusedWindow(){return focused;}};
  const openSave=()=>{windows=focusedOnly?[standard]:[saving,standard];if(focusedOnly)focused=saving;};
  const native=Object.assign(value=>value,{
    NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>({activateWithOptions(){activated++;if(activations-->0)frontmost=true;}})},
    AXUIElementCreateApplication:()=>app,AXUIElementCreateSystemWide:()=>({}),AXUIElementSetMessagingTimeout:()=>0,
    AXUIElementCopyAttributeValue:(element,key,ref)=>{
      if(readError)return -25204;
      if(element[key]===undefined)return -25212;
      ref[0]=element[key];return 0;
    },
    // Another app takes focus while the Export button is being focused.
    AXUIElementSetAttributeValue:(element,key,value)=>{if(!focusable)return -25205;element[key]=value;if(element===button&&loseFocus)frontmost=false;return 0;},
    // Live's Export button holds its AXPress reply while the Save panel it opens runs.
    AXUIElementPerformAction:element=>{presses.push(element.AXIdentifier);if(element!==button)return 0;if(pressRefused)return -25206;openSave();return -25204;},
    CFEqual:(a,b)=>a===b,
    CGWindowListCopyWindowInfo:()=>[...windows,...(focused&&!windows.includes(focused)?[focused]:[])].map(w=>({kCGWindowOwnerPID:42,kCGWindowName:w.AXTitle,kCGWindowNumber:w===exporting?123:w===saving?124:125}))
  });
  const events={applicationProcesses:{whose:()=>()=>[{bundleIdentifier:()=>"com.ableton.live",frontmost:()=>frontmost}]},
    keyCode:key=>{keys.push(key);if(frontmost)openSave();}};
  const run=vm.runInNewContext(`${source}\nrun`,{Application:()=>events,$:native,Ref:()=>[],delay(){},
    ObjC:{import(){},unwrap:value=>value,deepUnwrap:value=>value,castRefToObject:value=>value}});
  const panelState=Object.fromEntries(Object.entries(fields).map(([key,[,value]])=>[key,{value,enabled:true}]));
  return {keys,presses,get activated(){return activated;},execute:action=>JSON.parse(run([JSON.stringify({pid:42,action,windowId:123,panelState})])),
    close:()=>{windows=[standard];}};
}

test("Export presses its button through accessibility while another app stays in front",()=>{
  const native=nativeDialog({behind:true});
  assert.deepEqual(native.execute("commit"),{exportPressed:true,saveWindowId:124,exportPress:{steps:{export:"axPress"},keys:[],activations:0,
    axResult:-25204,liveFrontmostAfterPress:false,frontmostAfterPress:null,savePanelSource:"windows"}});
  assert.deepEqual(native.keys,[]);assert.deepEqual(native.presses,["Base.FinalButtonsBox.ExportButton"]);assert.equal(native.activated,0);
});

test("Export finds the Save panel through Live's focused window when AXWindows omits it",()=>{
  const native=nativeDialog({behind:true,focusedOnly:true}),result=native.execute("commit");
  assert.equal(result.saveWindowId,124);assert.equal(result.exportPress.savePanelSource,"focusedWindow");
  assert.deepEqual(native.keys,[]);assert.equal(native.activated,0);
});

test("Export falls back to Return only when its button refuses AXPress, and never sends it behind another app",()=>{
  const fallback=nativeDialog({behind:true,pressRefused:true}),result=fallback.execute("commit");
  assert.equal(result.exportPressed,true);assert.equal(result.saveWindowId,124);
  assert.deepEqual([result.exportPress.steps,result.exportPress.keys,result.exportPress.activations],[{export:"key"},["export"],1]);
  assert.deepEqual(fallback.keys,[36]);
  const behind=nativeDialog({behind:true,pressRefused:true,activations:0}),refused=behind.execute("commit");
  assert.equal(refused.exportPressed,false);assert.match(refused.error,/not foreground .*no key was sent/);assert.deepEqual(behind.keys,[]);
  const unfocused=nativeDialog({behind:true,pressRefused:true,focusable:false});assert.throws(()=>unfocused.execute("commit"),/not focused/);
  assert.deepEqual(unfocused.keys,[]);
});

test("Export cleanup refuses unavailable accessibility and an empty window tree",()=>{
  assert.deepEqual(Object.keys(nativeDialog({readError:true}).execute("status")),["uiComplete","observationError"]);
  assert.throws(()=>nativeDialog({readError:true}).execute("cancel"),/accessibility read failed/);
  assert.throws(()=>nativeDialog({empty:true}).execute("cancel"),/closure is unverified/);
  const closed=nativeDialog();closed.close();assert.equal(closed.execute("cancel").alreadyClosed,true);
});
