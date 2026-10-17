// Input is data. Only one verified Clip View Reverse action is permitted.
function run(argv){
 ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
 var input=JSON.parse(argv[0]),source=input.source,retained=[],requested=false;
 function read(e,k){var r=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(k),r);if(error===-25212||error===-25205)return null;if(error)throw Error('Audio reversal accessibility unavailable: '+k);var v=ObjC.castRefToObject(r[0]);retained.push(v);return v;}
 function get(e,k){return ObjC.unwrap(read(e,k));}
 function list(v){var a=[];if(v)for(var i=0;i<v.count;i++)a.push(v.objectAtIndex(i));return a;}
 function one(a,message){if(a.length!==1)throw Error(message);return a[0];}
 function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
 var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
 if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected the exact Live app');
 var root=$.AXUIElementCreateApplication(input.pid);
 function rows(e){var out=[];function walk(e,d){if(d>24||out.length>20000)throw Error('Audio reversal UI exceeds bounds');out.push(e);if(['AXBrowser','AXOutline'].indexOf(get(e,'AXRole'))>=0)return;list(read(e,'AXChildren')).forEach(function(c){walk(c,d+1);});}walk(e,0);return out;}
 function windowId(w){var title=get(w,'AXTitle'),all=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))).filter(function(v){return v.kCGWindowOwnerPID===input.pid&&v.kCGWindowName===title;});var visible=all.filter(function(v){return v.kCGWindowIsOnscreen===true;});if(visible.length)all=visible;return Number(one(all,'Audio reversal window identity is ambiguous').kCGWindowNumber);}
 function documentState(){
  var windows=list(read(root,'AXWindows'));
  if(windows.some(function(w){return get(w,'AXModal')===true||get(w,'AXSubrole')==='AXDialog'||list(read(w,'AXSheets')).length;}))throw Error('Resolve the existing native dialog before audio reversal');
  var candidates=windows.filter(function(w){var doc=get(w,'AXDocument');if(typeof doc!=='string'||!/^file:\/\//.test(doc))return false;var url=$.NSURL.URLWithString($(doc));return Number(url.isFileURL)===1&&ObjC.unwrap(url.path.stringByResolvingSymlinksInPath)===ObjC.unwrap($(source.filePath).stringByResolvingSymlinksInPath)&&rows(w).some(function(e){return get(e,'AXIdentifier')==='Transport';});});
  var w=one(candidates,'Exact Live Set window is unavailable'),all=rows(w);
  ['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].forEach(function(id){var value=get(one(all.filter(function(e){return get(e,'AXIdentifier')===id;}),'Native playback/record control unavailable'),'AXValue');if(value!==0&&value!==false)throw Error('Playback or recording changed before audio reversal');});
  if(all.some(function(e){return ['ContextMenu','ChooserPopUp'].indexOf(get(e,'AXIdentifier'))>=0;}))throw Error('Resolve the native popup before audio reversal');
  return {window:w,elements:all,state:{path:source.filePath,mainWindowId:windowId(w)}};
 }
 function inspection(){
  if(Number(app.active)!==1)throw Error('Live is not frontmost');
  var doc=documentState(),all=doc.elements,focus=read(root,'AXFocusedUIElement'),clipFocused=false,windowFocused=false;
  for(var depth=0;focus&&depth<16;depth++){if(get(focus,'AXIdentifier')==='ClipDetailView')clipFocused=true;if($.CFEqual(focus,doc.window))windowFocused=true;focus=read(focus,'AXParent');}
  if(!clipFocused||!windowFocused)throw Error('The exact Clip View must have native focus');
  var selected=[];all.filter(function(e){return get(e,'AXRole')==='AXOutline'&&get(e,'AXDescription')==='Track Headers';}).forEach(function(e){selected=selected.concat(list(read(e,'AXSelectedRows')));});
  var track=get(one(selected,'Exactly one audio track must be selected'),'AXIdentifier'),prefix=source.location==='session'?'SessionView':'ArrangementView';
  if(track!==prefix+source.trackUIPath+'.TitleBar')throw Error('Native audio reversal track changed');
  var name=get(one(all.filter(function(e){return get(e,'AXIdentifier')==='ClipDetailView.Header.HeaderText';}),'Exact audio Clip View title unavailable'),'AXValue');
  if(name!==source.name)throw Error('Native audio reversal clip title changed');
  var button=one(all.filter(function(e){return get(e,'AXIdentifier')==='ClipDetailView.SampleTools.ReverseButton'&&get(e,'AXRole')==='AXButton'&&get(e,'AXDescription')==='Reverse';}),'Exact audio Reverse button unavailable');
  if(get(button,'AXEnabled')!==true)throw Error('Native audio Reverse is disabled');
  return {button:button,state:{document:doc.state,track:track,name:name,button:'ClipDetailView.SampleTools.ReverseButton'}};
 }
 try{
  if(input.action==='document')return JSON.stringify(documentState().state);
  if(input.action==='inspect')return JSON.stringify(inspection().state);
  if(input.action!=='commit')throw Error('Unknown audio reversal action');
  var inspected=inspection();if(!same(inspected.state,input.expected))throw Error('Native audio reversal view changed before press');
  requested=null;if($.AXUIElementPerformAction(inspected.button,$('AXPress')))throw Error('Native Reverse action did not return');requested=true;
  return JSON.stringify({reverseRequested:true});
 }catch(error){return JSON.stringify({error:String(error.message||error),reverseRequested:requested});}
}
