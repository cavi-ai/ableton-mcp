import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../src/live-app-focus.js",import.meta.url),"utf8");
function focus({path="/Applications/Live.app",target=true,visible=false,staleActive=false,activationFrontmost=true}={}){
  const pressed=[],array=items=>({count:String(items.length),objectAtIndex:i=>items[i]});
  let actualFrontmost=false;
  const running={bundleIdentifier:"com.ableton.live",bundleURL:{path},active:false,activateWithOptions(){this.active=!staleActive;actualFrontmost=activationFrontmost;}};
  const items=[{AXSubrole:"AXApplicationDockItem",AXURL:{path:"/Applications/Other.app"}},
    ...(target?[{AXSubrole:"AXApplicationDockItem",AXURL:{path:"/Applications/Live.app"}}]:[])];
  const root={AXChildren:array([{AXChildren:array(items)}])};
  const appRoot={get AXFrontmost(){return actualFrontmost;}};
  const native=Object.assign(value=>value,{
    NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>running,runningApplicationsWithBundleIdentifier:()=>array([{processIdentifier:7}])},
    AXUIElementCreateApplication:pid=>pid===42?appRoot:root,
    AXUIElementCopyAttributeValue:(element,key,ref)=>{if(element[key]===undefined)return -25212;ref[0]=element[key];return 0;},
    AXUIElementPerformAction:element=>{pressed.push(element.AXURL.path);visible=true;actualFrontmost=true;return -25204;},
    CGWindowListCopyWindowInfo:()=>visible?[{kCGWindowOwnerPID:42,kCGWindowNumber:123}]:[]
  });
  const run=vm.runInNewContext(`${source}\nrun`,{$:native,Ref:()=>[],delay(){},
    ObjC:{import(){},unwrap:value=>value,deepUnwrap:value=>value,castRefToObject:value=>value}});
  return {pressed,execute:()=>JSON.parse(run([JSON.stringify({pid:42,appPath:"/Applications/Live.app",windowId:123})]))};
}

test("Live desktop activation selects the exact app URL and observes visibility after one press",()=>{
  const native=focus();assert.equal(native.execute().focused,true);assert.deepEqual(native.pressed,["/Applications/Live.app"]);
  const alreadyVisible=focus({visible:true});assert.equal(alreadyVisible.execute().focused,true);assert.deepEqual(alreadyVisible.pressed,[]);
});

test("Live desktop activation refuses another app path or a missing Dock item",()=>{
  for(const options of [{path:"/Applications/Other.app"},{target:false}]){
    const native=focus(options);assert.throws(()=>native.execute());assert.deepEqual(native.pressed,[]);
  }
});

test("Live desktop activation reads current focus despite cached AppKit activation state",()=>{
  const stale=focus({visible:true,target:false,staleActive:true});
  assert.equal(stale.execute().focused,true);assert.deepEqual(stale.pressed,[]);
  const lost=focus({visible:true,target:false,activationFrontmost:false});
  assert.throws(()=>lost.execute(),/Dock item is unavailable/);assert.deepEqual(lost.pressed,[]);
});
