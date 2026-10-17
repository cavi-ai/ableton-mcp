import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../src/live-audio-export-dialog.js",import.meta.url),"utf8");
function nativeDialog({empty=false,readError=false,focusable=true}={}){
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
  let windows=empty?[]:[exporting,standard];
  const app={get AXWindows(){return array(windows);}};
  const native=Object.assign(value=>value,{
    NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>({activateWithOptions(){}})},
    AXUIElementCreateApplication:()=>app,
    AXUIElementCopyAttributeValue:(element,key,ref)=>{
      if(readError)return -25204;
      if(element[key]===undefined)return -25212;
      ref[0]=element[key];return 0;
    },
    AXUIElementSetAttributeValue:(element,key,value)=>{if(!focusable)return -25205;element[key]=value;return 0;},
    AXUIElementPerformAction:element=>{presses.push(element.AXIdentifier);return 0;},
    CFEqual:(a,b)=>a===b,
    CGWindowListCopyWindowInfo:()=>windows.map(w=>({kCGWindowOwnerPID:42,kCGWindowName:w.AXTitle,kCGWindowNumber:w===exporting?123:w===saving?124:125}))
  });
  const events={applicationProcesses:{whose:()=>()=>[{bundleIdentifier:()=>"com.ableton.live",frontmost:()=>true}]},
    keyCode:key=>{keys.push(key);windows=[saving,standard];}};
  const run=vm.runInNewContext(`${source}\nrun`,{Application:()=>events,$:native,Ref:()=>[],delay(){},
    ObjC:{import(){},unwrap:value=>value,deepUnwrap:value=>value,castRefToObject:value=>value}});
  const panelState=Object.fromEntries(Object.entries(fields).map(([key,[,value]])=>[key,{value,enabled:true}]));
  return {keys,presses,execute:action=>JSON.parse(run([JSON.stringify({pid:42,action,windowId:123,panelState})])),
    close:()=>{windows=[standard];}};
}

test("Export activates its exact focused button with Return instead of synchronous AXPress",()=>{
  const native=nativeDialog();assert.deepEqual(native.execute("commit"),{exportPressed:true,saveWindowId:124});
  assert.deepEqual(native.keys,[36]);assert.deepEqual(native.presses,[]);
  const unfocused=nativeDialog({focusable:false});assert.throws(()=>unfocused.execute("commit"),/not focused/);
  assert.deepEqual(unfocused.keys,[]);assert.deepEqual(unfocused.presses,[]);
});

test("Export cleanup refuses unavailable accessibility and an empty window tree",()=>{
  assert.throws(()=>nativeDialog({readError:true}).execute("cancel"),/accessibility read failed/);
  assert.throws(()=>nativeDialog({empty:true}).execute("cancel"),/closure is unverified/);
  const closed=nativeDialog();closed.close();assert.equal(closed.execute("cancel").alreadyClosed,true);
});
