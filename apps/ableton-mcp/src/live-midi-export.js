// Inputs are data. This script owns one exact Live window and one export request.
function run(argv){
 ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
 var input=JSON.parse(argv[0]),source=input.source,retained=[],exportRequested=false;
 function read(e,k){var r=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(k),r);if(error===-25212||error===-25205)return null;if(error)throw Error('Native MIDI export accessibility unavailable: '+k);var v=ObjC.castRefToObject(r[0]);retained.push(v);return v;}
 function get(e,k){return ObjC.unwrap(read(e,k));}
 function list(v){var a=[];if(v)for(var i=0;i<v.count;i++)a.push(v.objectAtIndex(i));return a;}
 function one(a,message){if(a.length!==1)throw Error(message);return a[0];}
 function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
 var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
 if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected the exact Live app');
 var root=$.AXUIElementCreateApplication(input.pid);
 function foreground(){if(Number(app.active)!==1)throw Error('Live is not frontmost');}
 function windows(){return list(read(root,'AXWindows'));}
 function rows(e){var out=[];function walk(e,d){if(d>24||out.length>20000)throw Error('Native MIDI export UI exceeds bounds');out.push(e);var role=get(e,'AXRole'),id=get(e,'AXIdentifier');if(role==='AXBrowser'||role==='AXOutline'||id==='ClipDetailView.MidiEditorSplitter.NoteEditorView.KeyTrackRackView')return;list(read(e,'AXChildren')).forEach(function(c){walk(c,d+1);});}walk(e,0);return out;}
 function windowId(w){var title=get(w,'AXTitle'),all=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))).filter(function(v){return v.kCGWindowOwnerPID===input.pid&&v.kCGWindowName===title;});var visible=all.filter(function(v){return v.kCGWindowIsOnscreen===true;});if(visible.length)all=visible;return Number(one(all,'Native MIDI export window identity is ambiguous').kCGWindowNumber);}
 function documentState(){
  var all=windows();if(all.some(function(w){return get(w,'AXModal')===true||get(w,'AXSubrole')==='AXDialog'||list(read(w,'AXSheets')).length;}))throw Error('Resolve the existing native dialog before MIDI export');
  var candidates=all.filter(function(w){var doc=get(w,'AXDocument');if(source.filePath){if(typeof doc!=='string'||!/^file:\/\//.test(doc))return false;var url=$.NSURL.URLWithString($(doc));if(Number(url.isFileURL)!==1||ObjC.unwrap(url.path.stringByResolvingSymlinksInPath)!==ObjC.unwrap($(source.filePath).stringByResolvingSymlinksInPath))return false;}else if(doc!==null&&doc!=='')return false;return rows(w).some(function(e){return get(e,'AXIdentifier')==='Transport';});});
  var w=one(candidates,'Exact Live Set window is unavailable'),elements=rows(w);
  ['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].forEach(function(id){var e=one(elements.filter(function(e){return get(e,'AXIdentifier')===id;}),'Native recording control unavailable'),v=get(e,'AXValue');if(v!==0&&v!==false)throw Error('Native playback or recording changed');});
  if(elements.some(function(e){return ['ContextMenu','ChooserPopUp'].indexOf(get(e,'AXIdentifier'))>=0||get(e,'AXDescription')==='Browser Content Pane'&&get(e,'AXRole')==='AXTextField';}))throw Error('Resolve native popup or browser editing before MIDI export');
  return {window:w,elements:elements,state:{path:source.filePath,mainWindowId:windowId(w)}};
 }
 function inspection(){
  var doc=documentState(),all=doc.elements,focus=read(root,'AXFocusedUIElement');
  var clipFocused=false,mainFocused=false;for(var depth=0;focus&&depth<16;depth++){if(get(focus,'AXIdentifier')==='ClipDetailView'&&get(focus,'AXRole')==='AXGroup')clipFocused=true;if($.CFEqual(focus,doc.window))mainFocused=true;focus=read(focus,'AXParent');}if(!clipFocused||!mainFocused)throw Error('Exact clip detail or its child must have native focus');
  var selected=[];all.filter(function(e){return get(e,'AXRole')==='AXOutline'&&get(e,'AXDescription')==='Track Headers';}).forEach(function(e){selected=selected.concat(list(read(e,'AXSelectedRows')));});
  var header=get(one(selected,'Exactly one MIDI source track must be selected'),'AXIdentifier'),prefix=source.location==='session'?'SessionView':'ArrangementView';
  if(header!==prefix+source.trackUIPath+'.TitleBar')throw Error('Native MIDI source track changed');
  var editor=one(all.filter(function(e){return get(e,'AXIdentifier')==='ClipDetailView.MidiEditorSplitter.NoteEditorView.KeyTrackRackView';}),'Exact MIDI note editor unavailable'),title=get(editor,'AXTitle');
  var titlePrefix=source.location==='arrangement'?'Clip '+source.name+', ':source.name+', in track ';
  if(typeof title!=='string'||source.name&&title.indexOf(titlePrefix)!==0)throw Error('Native MIDI source clip title changed');
  if(source.location==='session'){var index=Number(source.clipId.split(':clip-')[1])+1;if(!(new RegExp(', scene '+index+'(?:\\D|$)')).test(title))throw Error('Native MIDI source scene changed');}
  var controls=all.filter(function(e){return /^ClipDetailView\.MainProperties\.(?:RegionProperties\.(?:StartAbsolute|OutMarker|LoopStart|LoopLength|LoopOnButton)|SignatureNumerator|SignatureDenominator)/.test(get(e,'AXIdentifier')||'');}).map(function(e){return {id:get(e,'AXIdentifier'),value:get(e,'AXValue')};});
  return Object.assign(doc.state,{trackUIId:header,editorTitle:title,controls:controls});
 }
 try{
  if(input.action==='document')return JSON.stringify(documentState().state);
  if(input.action==='inspect')return JSON.stringify(inspection());
  if(input.action==='finish'){
   var all=windows(),owned=all.filter(function(w){return get(w,'AXIdentifier')==='save-panel'&&windowId(w)===input.saveWindowId;});
   if(owned.length)return JSON.stringify({uiComplete:false});
   return JSON.stringify({uiComplete:true,document:documentState().state});
  }
  if(input.action!=='open')throw Error('Unknown MIDI export action');foreground();
  if(!same(inspection(),input.expected))throw Error('Native MIDI source view changed before export');
  var events=Application('System Events'),p=one(events.applicationProcesses.whose({unixId:input.pid})(),'Exact native Live process unavailable'),menu=p.menuBars()[0].menuBarItems.byName('File').menus()[0].menuItems.byName('Export MIDI Clip...');
  if(!menu.exists()||!menu.enabled())throw Error('Native Export MIDI Clip requires English Live and one MIDI clip');
  if(!same(inspection(),input.expected))throw Error('Native MIDI selection changed immediately before export');
  exportRequested=null;menu.actions.byName('AXPress').perform();exportRequested=true;
  var save;for(var i=0;i<40;i++){save=windows().filter(function(w){return get(w,'AXIdentifier')==='save-panel'&&get(w,'AXModal')===true;});if(save.length===1)break;delay(0.05);}
  return JSON.stringify({exportRequested:true,saveWindowId:windowId(one(save,'Owned MIDI export Save panel unavailable'))});
 }catch(error){return JSON.stringify({error:String(error.message||error),exportRequested:exportRequested,saveRequested:false,requiresInspection:exportRequested!==false});}
}
