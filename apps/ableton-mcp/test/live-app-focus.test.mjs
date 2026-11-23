import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../src/live-app-focus.js",import.meta.url),"utf8");
function focus({path="/Applications/Live.app",visible=false,frontPid=7,action,restorePid}={}){
  const pressed=[],activated=[];
  const running={bundleIdentifier:"com.ableton.live",bundleURL:{path},activateWithOptions(){activated.push("live");}};
  const native=Object.assign(value=>value,{
    NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>running},
    NSWorkspace:{sharedWorkspace:{frontmostApplication:{processIdentifier:frontPid,localizedName:frontPid===42?"Live":"Editor",bundleIdentifier:frontPid===42?"com.ableton.live":"com.example.editor"}}},
    AXUIElementPerformAction:element=>{pressed.push(element);return 0;},
    CGWindowListCopyWindowInfo:()=>visible?[{kCGWindowOwnerPID:42,kCGWindowNumber:123,kCGWindowIsOnscreen:true}]:[]
  });
  const run=vm.runInNewContext(`${source}\nrun`,{$:native,Ref:()=>[],delay(){},
    ObjC:{import(){},unwrap:value=>value,deepUnwrap:value=>value,castRefToObject:value=>value}});
  return {pressed,activated,execute:()=>JSON.parse(run([JSON.stringify({pid:42,appPath:"/Applications/Live.app",windowId:123,action,restorePid})]))};
}

test("a Live window already on screen is observed without activation or a Dock press",()=>{
  const shown=focus({visible:true});
  assert.deepEqual(shown.execute(),{focused:true,activations:0,dockPressed:false,previous:{pid:7,name:"Editor",bundleIdentifier:"com.example.editor"}});
  assert.deepEqual(shown.pressed,[]);assert.deepEqual(shown.activated,[]);
});

test("a hidden Live window stays hidden and does not become frontmost",()=>{
  const hidden=focus();
  assert.equal(hidden.execute().focused,false);
  assert.equal(hidden.execute().activations,0);
  assert.equal(hidden.execute().dockPressed,false);
  assert.deepEqual(hidden.pressed,[]);assert.deepEqual(hidden.activated,[]);
});

test("focus refuses another app path and restore activates nothing",()=>{
  assert.throws(()=>focus({path:"/Applications/Other.app"}).execute(),/exact running Live/);
  const restored=focus({action:"restore",restorePid:7,frontPid:7});
  assert.deepEqual(restored.execute(),{restored:true,activations:0,dockPressed:false,frontmost:{pid:7,name:"Editor",bundleIdentifier:"com.example.editor"}});
  const elsewhere=focus({action:"restore",restorePid:7,frontPid:42});
  assert.equal(elsewhere.execute().restored,false);
  assert.deepEqual(restored.activated,[]);assert.deepEqual(elsewhere.pressed,[]);
});
