import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const script=readFileSync(new URL('../src/live-midi-import.js',import.meta.url),'utf8');
function fixture({panelOpen=false,path='/Input/Phrase.mid',track='SessionView.Track[1].TitleBar',recording=0,cancelCloses=false,retainedOnscreen=false,frontmost=true,mainOnscreen=true,panelOnscreen=true,selected=true,navigate=false,selectionAvailable=true}={}){
 const array=a=>({count:a.length,objectAtIndex:i=>a[i]}),header={AXIdentifier:track},session={AXIdentifier:'SessionView',AXRole:'AXGroup'},controls=['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].map((AXIdentifier,i)=>({AXIdentifier,AXValue:i===1?recording:0}));
 const main={AXTitle:'Set',AXRole:'AXWindow',AXDocument:'file:///Set.als',AXChildren:array([{AXIdentifier:'Transport'},{AXRole:'AXOutline',AXDescription:'Track Headers',AXSelectedRows:array([header])},session,...controls])};session.AXParent=main;
 const rowFor=(path,hasDirectoryPath)=>({AXChildren:array([{AXURL:{isFileURL:1,hasDirectoryPath,filePathURL:{path}}}])});
 const row=rowFor(path,0),folder=rowFor('/Input/',1);
 const list={AXRole:'AXList',AXChildren:array([row]),AXSelectedChildren:array(selected?[row]:[])};
 const column={AXChildren:array([list])},folderColumn={AXChildren:array([{AXRole:'AXList',AXChildren:array([folder])}])};
 const browser={AXRole:'AXBrowser',AXIdentifier:'ColumnView',AXColumns:array(navigate?[folderColumn]:[column])};
 const button={AXIdentifier:'OKButton',get AXEnabled(){return list.AXSelectedChildren.count>0;}},cancel={AXIdentifier:'CancelButton',AXEnabled:true};
 const panel={AXTitle:'Open',AXRole:'AXWindow',AXIdentifier:'open-panel',AXModal:true,AXChildren:array([{AXIdentifier:'_messageTextField',AXValue:'Import Audio or MIDI File:'},browser,button,cancel])};
 let windows=panelOpen?[main,panel]:[main],presses=0,imports=0;
 const native=Object.assign(v=>typeof v==='string'?Object.assign(new String(v),{stringByResolvingSymlinksInPath:v}):v,{
  NSRunningApplication:{runningApplicationWithProcessIdentifier:()=>({bundleIdentifier:'com.ableton.live',bundleURL:{path:'/Live.app'},active:frontmost?1:0})},
  AXUIElementCreateApplication:()=>({get AXWindows(){return array(windows);},AXFocusedUIElement:session}),
  AXUIElementCopyAttributeValue:(e,k,r)=>{if(e[k]===undefined)return -25212;r[0]=e[k];return 0;},
  NSArray:{arrayWithObject:e=>array([e])},
  AXUIElementSetAttributeValue:(e,k,value)=>{if(!selectionAvailable||e!==list||String(k)!=='AXSelectedChildren')return -25205;e[k]=value;return 0;},
  AXUIElementPerformAction:(e,action)=>{
   presses++;
   if(e===folder&&String(action)==='AXOpen')browser.AXColumns=array([folderColumn,column]);
   if(e===row||e===button){imports++;windows=[main];}
   if(e===cancel&&cancelCloses)windows=[main];
   return 0;
  },
  CFEqual:(a,b)=>a===b,
  NSURL:{URLWithString:()=>({isFileURL:1,path:{stringByResolvingSymlinksInPath:'/Set.als'}})},
  CGWindowListCopyWindowInfo:option=>windows.map(w=>({kCGWindowOwnerPID:42,kCGWindowName:w.AXTitle,kCGWindowNumber:w===main?1:2,kCGWindowIsOnscreen:w===main?mainOnscreen:panelOnscreen})).concat(retainedOnscreen&&!windows.includes(panel)?[{kCGWindowOwnerPID:42,kCGWindowName:'Open',kCGWindowNumber:2,kCGWindowIsOnscreen:true}]:[]).filter(w=>option!==1||w.kCGWindowIsOnscreen),
  NSFileManager:{defaultManager:{attributesOfItemAtPathError:()=>({objectForKey:k=>({NSFileType:'NSFileTypeRegular',NSFileSystemNumber:{stringValue:'1'},NSFileSystemFileNumber:{stringValue:'2'},NSFileSize:{stringValue:'24'},NSFileModificationDate:{timeIntervalSince1970:1}})[k]})}}
 });
 const menu={exists:()=>true,enabled:()=>true,actions:{byName:()=>({perform:()=>{presses++;windows.push(panel);}})}},process={menuBars:()=>[{menuBarItems:{byName:()=>({menus:()=>[{menuItems:{byName:()=>menu}}]})}}]},run=vm.runInNewContext(`${script}\nrun`,{$:native,Ref:()=>[],delay(){},ObjC:{import(){},unwrap:v=>v instanceof String?v.toString():v,castRefToObject:v=>v,deepUnwrap:v=>v},Application:()=>({applicationProcesses:{whose:()=>()=>[process]}})});
 const base={pid:42,appPath:'/Live.app',source:{filePath:'/Set.als',trackUIPath:'.Track[1]',clipId:'track-1:clip-0',sceneIndex:0},path:'/Input/Phrase.mid',windowId:2,document:{path:'/Set.als',mainWindowId:1},file:{dev:'1',ino:'2',size:'24',mtimeMs:1000}};
 return {execute:(action,extra={})=>JSON.parse(run([JSON.stringify({...base,action,...extra})])),get presses(){return presses;},get imports(){return imports;}};
}
test('native MIDI picker opens only from the exact Session owner',()=>{const f=fixture(),expected=f.execute('inspect');assert.equal(f.execute('openPicker',{expected}).windowId,2);assert.equal(f.presses,1);});
test('native Open verifies the exact file URL, document and owner',()=>{const f=fixture({panelOpen:true});assert.equal(f.execute('commit').importRequested,true);assert.equal(f.presses,1);});
test('another file, track, document or recording state refuses before Open input',()=>{for(const setup of [{path:'/Other.mid'},{track:'SessionView.Track[0].TitleBar'},{recording:1}]){const f=fixture({panelOpen:true,...setup}),result=f.execute('commit');assert.ok(result.error);assert.equal(result.importRequested,false);assert.equal(f.presses,0);}const f=fixture({panelOpen:true}),result=f.execute('commit',{document:{path:'/Other.als',mainWindowId:1}});assert.ok(result.error);assert.equal(f.presses,0);});

test('cancellation requires both AX and owned onscreen window closure',()=>{for(const options of [{cancelCloses:false},{cancelCloses:true,retainedOnscreen:true},{cancelCloses:true}]){const f=fixture({panelOpen:true,...options}),r=f.execute('cancel');assert.equal(r.cancelled,options.cancelCloses===true&&!options.retainedOnscreen);assert.equal(f.presses,1);}});

test('preparing a file in a child column leaves the actual import for commit',()=>{
 const f=fixture({panelOpen:true,selected:false,navigate:true});
 const prepared=f.execute('prepare');
 assert.equal(f.imports,0);
 assert.deepEqual(prepared,{prepared:true,windowId:2,path:'/Input/Phrase.mid'});
 assert.equal(f.execute('commit').importRequested,true);
 assert.equal(f.imports,1);
});

test('unavailable file selection aborts without opening the file',()=>{
 const f=fixture({panelOpen:true,selected:false,selectionAvailable:false});
 const result=f.execute('prepare');
 assert.equal(f.imports,0);
 assert.ok(result.error);
 assert.equal(result.importRequested,false);
});

test('onscreen Live can import MIDI while another app is frontmost',()=>{
 const f=fixture({frontmost:false});
 assert.equal(f.execute('openPicker',{expected:f.execute('inspect')}).windowId,2);
 assert.equal(f.execute('prepare').prepared,true);
 assert.equal(f.execute('commit').importRequested,true);
});

test('offscreen Live cannot open the MIDI picker',()=>{
 const expected=fixture().execute('inspect'),f=fixture({mainOnscreen:false});
 assert.match(f.execute('openPicker',{expected}).error??'',/not on screen/);
 assert.equal(f.presses,0);
});

test('cleanup cancels an unidentified picker with nothing selected on another desktop, and presses nothing without one',()=>{
 const f=fixture({panelOpen:true,selected:false,cancelCloses:true,panelOnscreen:false,frontmost:false}),r=f.execute('cancel',{windowId:null});
 assert.equal(r.cancelled,true);assert.equal(r.importRequested,false);assert.equal(f.presses,1);assert.equal(f.imports,0);
 const none=fixture({frontmost:false}),empty=none.execute('cancel',{windowId:null});
 assert.equal(empty.cancelled,true);assert.equal(empty.pickerFound,false);assert.equal(none.presses,0);
});

test('an offscreen MIDI picker cannot commit the import',()=>{
 const f=fixture({panelOpen:true,panelOnscreen:false});
 assert.match(f.execute('commit').error??'',/not on screen/);
 assert.equal(f.imports,0);
});
