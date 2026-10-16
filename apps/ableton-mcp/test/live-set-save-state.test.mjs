import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const source=readFileSync(new URL("../src/live-set-save-state.js",import.meta.url),"utf8");

function observe({frontmost=true,bundle="com.ableton.live",modal=false,sheet=false,main=true,document="file:///tmp/Song.als",save=false,saveAs=true,duplicate=false}={}) {
  const window={sheets:()=>sheet?[{}]:[],attributes:{byName:key=>({value:()=>({AXMain:main,AXModal:modal,AXDocument:document})[key]})}};
  const file={menuItems:{byName:name=>({exists:()=>true,enabled:()=>name==="Save Live Set"?save:saveAs})}};
  const process={bundleIdentifier:()=>bundle,frontmost:()=>frontmost,windows:()=>duplicate?[window,window]:[window],
    menuBars:()=>[{menuBarItems:{byName:()=>({menus:()=>[file]})}}]};
  const run=vm.runInNewContext(`${source}\nrun`,{Application:()=>({applicationProcesses:{whose:()=>()=>[process]}})});
  return ()=>JSON.parse(run([JSON.stringify({pid:42})]));
}
test("native save-state observation reports literal menu state and refuses uncertain UI context",()=>{
  assert.equal(observe()().saveEnabled,false);
  assert.equal(observe({save:true})().saveEnabled,true);
  for(const state of [{frontmost:false},{bundle:"other.app"},{modal:true},{sheet:true},{main:false},{document:""},{saveAs:false},{duplicate:true}])
    assert.throws(observe(state));
});
