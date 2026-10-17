// Own one native import request and its exact file chooser. Inputs are data.
function run(argv){
 ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
 var input=JSON.parse(argv[0]),source=input.source,retained=[],pickerRequested=false,importRequested=false;
 function read(e,k){var r=Ref(),code=$.AXUIElementCopyAttributeValue(e,$(k),r);if(code===-25212||code===-25205)return null;if(code)throw Error('Native MIDI import accessibility unavailable: '+k);var v=ObjC.castRefToObject(r[0]);retained.push(v);return v;}
 function get(e,k){return ObjC.unwrap(read(e,k));}function items(v){var a=[];if(v)for(var i=0;i<v.count;i++)a.push(v.objectAtIndex(i));return a;}
 function one(a,message){if(a.length!==1)throw Error(message);return a[0];}function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
 var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
 if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected the exact Live app');
 var root=$.AXUIElementCreateApplication(input.pid);
 function foreground(){if(Number(app.active)!==1)throw Error('Live is not frontmost');}
 function windows(){return items(read(root,'AXWindows'));}
 function rows(e){var a=[];function walk(e,d){if(d>24||a.length>20000)throw Error('Native MIDI import UI exceeds bounds');a.push(e);if(['AXBrowser','AXOutline','AXTable'].indexOf(get(e,'AXRole'))>=0)return;items(read(e,'AXChildren')).forEach(function(c){walk(c,d+1);});}walk(e,0);return a;}
 function find(e,id){return one(rows(e).filter(function(c){return get(c,'AXIdentifier')===id;}),'Native MIDI import control unavailable: '+id);}
 function windowId(w){var all=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))).filter(function(v){return v.kCGWindowOwnerPID===input.pid&&v.kCGWindowName===get(w,'AXTitle');}),visible=all.filter(function(v){return v.kCGWindowIsOnscreen===true;});return Number(one(visible.length?visible:all,'Native MIDI import window identity is ambiguous').kCGWindowNumber);}
 function mainDocument(allowOpen){
  var all=windows();if(all.some(function(w){return (get(w,'AXModal')===true||get(w,'AXSubrole')==='AXDialog'||items(read(w,'AXChildren')).some(function(c){return get(c,'AXRole')==='AXSheet';}))&&!(allowOpen&&get(w,'AXIdentifier')==='open-panel'&&windowId(w)===input.windowId);}))throw Error('Resolve the existing native dialog before MIDI import');
  var candidates=all.filter(function(w){var doc=get(w,'AXDocument');if(source.filePath){if(typeof doc!=='string'||!/^file:\/\//.test(doc))return false;var url=$.NSURL.URLWithString($(doc));if(Number(url.isFileURL)!==1||ObjC.unwrap(url.path.stringByResolvingSymlinksInPath)!==ObjC.unwrap($(source.filePath).stringByResolvingSymlinksInPath))return false;}else if(doc!==null&&doc!=='')return false;return rows(w).some(function(e){return get(e,'AXIdentifier')==='Transport';});});
  var w=one(candidates,'Exact MIDI import Set window unavailable'),all=rows(w);
  ['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].forEach(function(id){var c=one(all.filter(function(e){return get(e,'AXIdentifier')===id;}),'Native recording control unavailable'),v=get(c,'AXValue');if(v!==0&&v!==false)throw Error('Native playback or recording changed');});
  if(all.some(function(e){return ['ContextMenu','ChooserPopUp'].indexOf(get(e,'AXIdentifier'))>=0||get(e,'AXDescription')==='Browser Content Pane'&&get(e,'AXRole')==='AXTextField';}))throw Error('Resolve native popup or browser editing before MIDI import');
  return {window:w,elements:all,state:{path:source.filePath,mainWindowId:windowId(w)}};
 }
 function header(doc){var selected=[];doc.elements.filter(function(e){return get(e,'AXRole')==='AXOutline'&&get(e,'AXDescription')==='Track Headers';}).forEach(function(e){selected=selected.concat(items(read(e,'AXSelectedRows')));});var id=get(one(selected,'Exactly one MIDI staging track must be selected'),'AXIdentifier');if(id!=='SessionView'+source.trackUIPath+'.TitleBar')throw Error('Native MIDI staging track changed');return id;}
 function inspection(){var doc=mainDocument(false),focus=read(root,'AXFocusedUIElement'),session=false,main=false;for(var depth=0;focus&&depth<16;depth++){if(get(focus,'AXIdentifier')==='SessionView')session=true;if($.CFEqual(focus,doc.window))main=true;focus=read(focus,'AXParent');}if(!session||!main)throw Error('Exact Session view must have native focus');return Object.assign(doc.state,{trackUIId:header(doc)});}
 function panel(){foreground();var p=one(windows().filter(function(w){return get(w,'AXIdentifier')==='open-panel'&&get(w,'AXModal')===true;}),'Owned native Open panel unavailable');if(windowId(p)!==input.windowId||get(find(p,'_messageTextField'),'AXValue')!=='Import Audio or MIDI File:')throw Error('Native MIDI import panel ownership changed');return p;}
 function sheets(p){return items(read(p,'AXChildren')).filter(function(c){return get(c,'AXRole')==='AXSheet';});}
 function fileSelection(p){
  if(sheets(p).length)throw Error('Resolve native file-picker sheet before Open');var browser=find(p,'ColumnView'),urls=[];
  items(read(browser,'AXColumns')).forEach(function(column){items(read(column,'AXChildren')).filter(function(e){return get(e,'AXRole')==='AXList';}).forEach(function(list){items(read(list,'AXSelectedChildren')).forEach(function(row){items(read(row,'AXChildren')).forEach(function(child){var url=read(child,'AXURL');if(url&&Number(url.isFileURL)===1&&Number(url.hasDirectoryPath)!==1)urls.push(ObjC.unwrap(url.filePathURL.path));});});});});
  var path=one(urls,'Exactly one native MIDI file must be selected');if(path!==input.path)throw Error('Native MIDI import file selection changed');if(get(find(p,'OKButton'),'AXEnabled')!==true)throw Error('Native MIDI Open is disabled');return path;
 }
 function waitFor(read,message){for(var i=0;i<40;i++){foreground();var value=read();if(value)return value;delay(.05);}throw Error(message);}
 try{
  if(input.action==='document')return JSON.stringify(mainDocument(false).state);
  if(input.action==='inspect')return JSON.stringify(inspection());
  if(input.action==='finish'){var owned=windows().filter(function(w){return get(w,'AXIdentifier')==='open-panel'&&windowId(w)===input.windowId;});if(owned.length)return JSON.stringify({uiComplete:false});return JSON.stringify({uiComplete:true,document:mainDocument(false).state});}
  if(input.action==='openPicker'){
   foreground();if(!same(inspection(),input.expected))throw Error('Native MIDI staging view changed');var events=Application('System Events'),process=one(events.applicationProcesses.whose({unixId:input.pid})(),'Exact Live process unavailable'),menu=process.menuBars()[0].menuBarItems.byName('Create').menus()[0].menuItems.byName('Import MIDI File...');if(!menu.exists()||!menu.enabled())throw Error('Native Import MIDI File requires English Live and an empty MIDI destination');if(!same(inspection(),input.expected))throw Error('Native MIDI destination changed before opening file picker');pickerRequested=null;menu.actions.byName('AXPress').perform();pickerRequested=true;var open=waitFor(function(){var a=windows().filter(function(w){return get(w,'AXIdentifier')==='open-panel'&&get(w,'AXModal')===true;});return a.length===1&&a[0];},'Owned native MIDI file picker unavailable');if(get(find(open,'_messageTextField'),'AXValue')!=='Import Audio or MIDI File:')throw Error('Unexpected native Open purpose');return JSON.stringify({windowId:windowId(open),pickerRequested:true});
  }
  var p=panel();
  if(input.action==='prepare'){
   if(sheets(p).length)throw Error('Existing Open panel sheet changed');var events=Application('System Events');events.keystroke('g',{using:['command down','shift down']});var sheet=waitFor(function(){var a=sheets(p);return a.length===1&&a[0];},'MIDI import path sheet unavailable');if(get(sheet,'AXIdentifier')!=='GoToWindow')throw Error('Unexpected MIDI path sheet');var field=find(sheet,'PathTextField');if($.AXUIElementSetAttributeValue(field,$('AXValue'),$(input.path))||$.AXUIElementSetAttributeValue(field,$('AXFocused'),$(true)))throw Error('Native MIDI path field is unavailable');if(get(field,'AXValue')!==input.path||get(field,'AXFocused')!==true)throw Error('Native MIDI path field changed');foreground();events.keyCode(36);waitFor(function(){return sheets(p).length===0;},'MIDI file path navigation is unconfirmed');var path=fileSelection(p);return JSON.stringify({prepared:true,windowId:input.windowId,path:path});
  }
  if(input.action==='cancel'){
   fileSelection(p);if($.AXUIElementPerformAction(find(p,'CancelButton'),$('AXPress')))throw Error('Native Open cancellation is unconfirmed');
   for(var attempt=0;attempt<40;attempt++){
    var axPresent=windows().some(function(w){return get(w,'AXIdentifier')==='open-panel'&&windowId(w)===input.windowId;}),cgPresent=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))).some(function(w){return w.kCGWindowOwnerPID===input.pid&&w.kCGWindowNumber===input.windowId&&w.kCGWindowIsOnscreen===true;});
    if(!axPresent&&!cgPresent)return JSON.stringify({cancelled:true,importRequested:false});delay(.05);
   }
   return JSON.stringify({cancelled:false,importRequested:false,requiresInspection:true});
  }
  if(input.action!=='commit')throw Error('Unknown native MIDI import action');
  var document=mainDocument(true);if(!same(document.state,input.document))throw Error('Native MIDI import Set changed before Open');header(document);fileSelection(p);
  var file=$.NSFileManager.defaultManager.attributesOfItemAtPathError($(input.path),null),expected=input.file;
  if(!file||ObjC.unwrap(file.objectForKey($('NSFileType')))!=='NSFileTypeRegular'||ObjC.unwrap(file.objectForKey($('NSFileSystemNumber')).stringValue)!==expected.dev||ObjC.unwrap(file.objectForKey($('NSFileSystemFileNumber')).stringValue)!==expected.ino||ObjC.unwrap(file.objectForKey($('NSFileSize')).stringValue)!==expected.size||Math.abs(Number(file.objectForKey($('NSFileModificationDate')).timeIntervalSince1970)*1000-expected.mtimeMs)>1)throw Error('Native MIDI source file identity changed before Open');
  foreground();fileSelection(p);importRequested=null;var code=$.AXUIElementPerformAction(find(p,'OKButton'),$('AXPress'));if(code)throw Error('Native MIDI Open outcome is unknown');importRequested=true;return JSON.stringify({importRequested:true});
 }catch(error){return JSON.stringify({error:String(error.message||error),importRequested:importRequested,requiresInspection:importRequested!==false||pickerRequested!==false||input.action==='prepare'});}
}
