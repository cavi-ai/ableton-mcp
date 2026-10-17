import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/live-device-preset.js',import.meta.url),'utf8');
function fixture({nested=false,busyAfterSave=false,keepEditor=false}={}){
 const array=items=>({count:items.length,objectAtIndex:i=>items[i]});
 const track={AXIdentifier:'SessionView.Track[0].TitleBar'},other={AXIdentifier:'SessionView.Track[1].TitleBar'},chain={},otherChain={};
 const headers={AXRole:'AXOutline',AXDescription:'Track Headers',AXSelectedRows:array([track])};
 const outline={AXRole:'AXOutline',AXDescription:'Chain List',AXRows:array([chain,otherChain]),AXSelectedRows:array([chain])};
 const toggle={AXRole:'AXCheckBox',AXDescription:'Show/Hide Chain List',AXValue:0};
 const rack={AXIdentifier:'TrackView.Device[0]',AXChildren:array([toggle])};
 const save={AXRole:'AXButton',AXDescription:'Save Preset',AXEnabled:true};
 const device={AXRole:'AXGroup',AXIdentifier:nested?'TrackView.Device[0].Device[0]':'TrackView.Device[0]',AXTitle:'Omnisphere',AXChildren:array([save])};
 const main={AXDocument:'file:///Test.als',AXTitle:'Test',AXChildren:array([headers,...['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].map(AXIdentifier=>({AXIdentifier,AXValue:0})),...(nested?[rack]:[]),device])};
 const root={AXWindows:array([main]),AXFocusedUIElement:device};let presses=0,keys=0,clock=0,unavailable=0;
 const app={bundleIdentifier:'com.ableton.live',bundleURL:{path:'/Live.app'},active:1};
 const native=Object.assign(value=>typeof value==='string'?Object.assign(new String(value),{stringByResolvingSymlinksInPath:value}):value,{
  NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>app},AXUIElementCreateApplication:()=>root,
  NSURL:{URLWithString:()=>({isFileURL:1,path:{stringByResolvingSymlinksInPath:'/Test.als'}})},
  AXUIElementCopyAttributeValue:(e,k,r)=>{if(k==='AXChildren'&&unavailable>0){unavailable--;return -25204;}if(e[k]===undefined)return -25212;r[0]=e[k];return 0;},CFEqual:(a,b)=>a===b,
  AXUIElementPerformAction:e=>{if(e===toggle){toggle.AXValue=1;rack.AXChildren=array([toggle,outline]);}else if(e===save){presses++;if(busyAfterSave)unavailable=2;if(keepEditor){const field={AXRole:'AXTextField',AXDescription:'Browser Content Pane',AXValue:'Kept.vstpreset'};main.AXChildren=array([field,...Array.from({length:main.AXChildren.count},(_,i)=>main.AXChildren.objectAtIndex(i))]);root.AXFocusedUIElement=field;}}return 0;},
  CGWindowListCopyWindowInfo:()=>[{kCGWindowOwnerPID:42,kCGWindowName:'Test',kCGWindowNumber:1}]
 });
 const run=vm.runInNewContext(`${source}\nrun`,{$:native,Ref:()=>[],delay(){},Date:{now:()=>clock+=100},ObjC:{import(){},unwrap:v=>v instanceof String?v.toString():v,castRefToObject:v=>v,deepUnwrap:v=>v},Application:()=>({keyCode(){keys++;}})});
 const input={pid:42,appPath:'/Live.app',filePath:'/Test.als',deviceName:'Omnisphere',deviceClass:'Omnisphere',presetName:'Kept',uiIdentity:{trackPath:'.Track[0]',devicePath:device.AXIdentifier,chains:nested?[{rackUIId:rack.AXIdentifier,index:0,count:2}]:[]}};
 return {execute:(action,extra={})=>JSON.parse(run([JSON.stringify({...input,action,...extra})])),switchTrack(){headers.AXSelectedRows=array([other]);},switchChain(){outline.AXSelectedRows=array([otherChain]);},get presses(){return presses;},get keys(){return keys;}};
}
test('identical plug-in titles and indices on another track refuse before Save',()=>{const f=fixture(),prepared=f.execute('inspect');assert.equal(prepared.trackUIId,'SessionView.Track[0].TitleBar');f.switchTrack();const result=f.execute('commit',{prepared});assert.match(result.error,/owning track/);assert.equal(result.saveRequested,false);assert.equal(f.presses,0);});
test('nested ownership opens the exact chain list and rejects another selected chain',()=>{const f=fixture({nested:true});assert.match(f.execute('inspect').error,/chain list/);const prepared=f.execute('reveal');assert.equal(prepared.chains[0].index,0);assert.equal(f.execute('prepare',{expected:prepared}).deviceUIId,'TrackView.Device[0].Device[0]');f.switchChain();const result=f.execute('commit',{prepared});assert.match(result.error,/owning rack chain/);assert.equal(result.saveRequested,false);assert.equal(f.presses,0);});

test('a transient accessibility refresh after Save retries reads without pressing Save again',()=>{const f=fixture({busyAfterSave:true}),prepared=f.execute('inspect');const result=f.execute('commit',{prepared});assert.equal(result.saveRequested,true);assert.equal(result.uiIdle,true);assert.equal(f.presses,1);});

test('an unresolved owned name editor receives Return only once and withholds idle verification',()=>{const f=fixture({keepEditor:true}),prepared=f.execute('inspect'),r=f.execute('commit',{prepared});assert.equal(r.saveRequested,true);assert.equal(r.uiIdle,false);assert.equal(f.presses,1);assert.equal(f.keys,1);});
