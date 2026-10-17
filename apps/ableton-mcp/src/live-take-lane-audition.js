// Native macOS accessibility for one indexed take lane; no keyboard or coordinates.
function takeLaneFlag(value){
  if(value===true||value===1)return true;
  if(value===false||value===0)return false;
  throw Error('Native checkbox state is unknown');
}
function requireTakeDocument(expected,observed){
  if(typeof expected!=='string'||expected[0]!=='/'||typeof observed!=='string'||observed[0]!=='/')throw Error('Saved Set document identity is unavailable');
  if(expected!==observed)throw Error('Native Set and visible document differ');
  return observed;
}
function run(argv){
  ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
  var input=JSON.parse(argv[0]),retained=[],actionRequested=false;
  function read(e,key){var ref=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(key),ref);if(error===-25212||error===-25205)return null;if(error)throw Error('Live accessibility read failed: '+key+' ('+error+')');var value=ObjC.castRefToObject(ref[0]);retained.push(value);return value;}
  function get(e,key){return ObjC.unwrap(read(e,key));}
  function items(v){var a=[];if(v)for(var i=0;i<v.count;i++)a.push(v.objectAtIndex(i));return a;}
  function children(e){return items(read(e,'AXChildren'));}
  function find(root,id){var matches=[],count=0;function walk(e,d){if(d>8||++count>20000)throw Error('Live accessibility tree exceeds supported bounds');if(get(e,'AXIdentifier')===id){matches.push(e);return;}children(e).forEach(function(c){walk(c,d+1);});}walk(root,0);return matches;}
  function one(values,message){if(values.length!==1)throw Error(message);return values[0];}
  var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
  if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected the exact Live process');
  var root=$.AXUIElementCreateApplication(input.pid);
  function documentPath(w){
    var document=get(w,'AXDocument');
    if(typeof document!=='string'||!/^file:\/\//.test(document))throw Error('Saved Set document identity is unavailable');
    var url=$.NSURL.URLWithString($(document));
    if(!url||Number(url.isFileURL)!==1)throw Error('Saved Set document identity is unavailable');
    var expected=typeof input.filePath==='string'&&input.filePath[0]==='/'?ObjC.unwrap($(input.filePath).stringByResolvingSymlinksInPath):null,
      observed=ObjC.unwrap(url.path.stringByResolvingSymlinksInPath);
    return requireTakeDocument(expected,observed);
  }
  function window(){
    var windows=items(read(root,'AXWindows'));
    if(windows.some(function(w){return get(w,'AXModal')===true||items(read(w,'AXSheets')).length>0;}))throw Error('Resolve the native Live modal before take audition');
    var result=one(windows.filter(function(w){return get(w,'AXTitle')===input.setName;}),'Exact Live Set window unavailable or ambiguous');
    documentPath(result);return result;
  }
  function windowId(){var list=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))).filter(function(w){return w.kCGWindowOwnerPID===input.pid&&w.kCGWindowName===input.setName;});return Number(one(list,'Exact Live window identity unavailable').kCGWindowNumber);}
  function mode(w){if(find(w,'ArrangementView').length===1)return 'arrangement';if(find(w,'SessionView').length===1)return 'session';return 'unknown';}
  function header(w){
    var manager=one(find(w,'ArrangementView.ArrangerHeaderManager'),'Arrangement headers unavailable'),rows=children(manager),
      found=rows.filter(function(r){return get(r,'AXIdentifier')===input.uiTrackPath+'.TitleBar';}),row=one(found,'Exact track header unavailable');
    var title=one(children(row).filter(function(c){return get(c,'AXIdentifier')===input.uiTrackPath+'.TitleBar.TitleBarEditField';}),'Track title unavailable');
    if(get(title,'AXValue')!==input.trackName)throw Error('Native track and UI header differ');
    return {rows:rows,row:row,index:rows.findIndex(function(r){return $.CFEqual(r,row);})};
  }
  function visibility(row){return one(children(row).filter(function(c){return get(c,'AXRole')==='AXCheckBox'&&get(c,'AXDescription')==='Show/Hide Take Lanes';}),'Take visibility control unavailable');}
  function lanes(header){
    var result=[];
    for(var i=header.index+1;i<header.rows.length;i++){
      var row=header.rows[i];if(get(row,'AXIdentifier'))break;
      var fields=children(row),names=fields.filter(function(c){return get(c,'AXIdentifier')===input.uiTrackPath+'.Header.TakeLaneController.TitleBarEditField';}),
        buttons=fields.filter(function(c){return get(c,'AXIdentifier')===input.uiTrackPath+'.Header.TakeLaneController.Audition'&&get(c,'AXRole')==='AXCheckBox';});
      if(names.length!==1||buttons.length!==1)throw Error('Take row shape is unavailable or ambiguous');
      result.push({name:get(names[0],'AXValue'),audition:takeLaneFlag(get(buttons[0],'AXValue')),button:buttons[0]});
    }
    if(result.length!==input.laneNames.length||result.some(function(l,index){return l.name!==input.laneNames[index];}))throw Error('Native lane inventory and visible rows differ');
    if(result.filter(function(l){return l.audition;}).length>1)throw Error('Multiple lane audition flags are active');
    return result;
  }
  function snapshot(){
    var w=window(),view=mode(w),result={pid:input.pid,windowId:windowId(),windowTitle:input.setName,documentPath:documentPath(w),mode:view,visible:false,lanes:[]};
    if(view!=='arrangement')return result;
    var h=header(w),value=takeLaneFlag(get(visibility(h.row),'AXValue'));
    if(!value)return result;
    result.visible=true;result.lanes=lanes(h).map(function(l,index){return {index:index,name:l.name,audition:l.audition};});return result;
  }
  function press(e){if(get(e,'AXEnabled')!==true)throw Error('Native take control is disabled');actionRequested=true;if($.AXUIElementPerformAction(e,$('AXPress')))throw Error('Native action outcome is unknown');}
  function waitFor(read,message){for(var i=0;i<40;i++){var result=read();if(result)return result;delay(0.05);}throw Error(message);}
  function toggleArrangement(){
    var bar=read(root,'AXMenuBar'),view=one(children(bar).filter(function(e){return get(e,'AXTitle')==='View';}),'View menu unavailable'),
      menu=one(children(view).filter(function(e){return get(e,'AXRole')==='AXMenu';}),'View menu contents unavailable'),
      item=one(children(menu).filter(function(e){return get(e,'AXRole')==='AXMenuItem'&&get(e,'AXTitle')==='Toggle Arrangement/Session View';}),'Arrangement view command unavailable');
    press(item);waitFor(function(){return mode(window())==='arrangement';},'Arrangement view did not open');
  }
  try{
    var current=snapshot();if(input.action==='inspect')return JSON.stringify(current);
    if(Number(app.active)!==1)throw Error('Live is not frontmost; no action sent');
    if(JSON.stringify(current)!==JSON.stringify(input.expectedUI))throw Error('Visible take audition context changed');
    if(input.action==='show'){
      if(current.mode==='session')toggleArrangement();else if(current.mode!=='arrangement')throw Error('Live view is unsupported');
      var h=header(window()),toggle=visibility(h.row),value=takeLaneFlag(get(toggle,'AXValue'));
      if(!value)press(toggle);
      return JSON.stringify(waitFor(function(){var s=snapshot();return s.visible?s:null;},'Take lanes did not become visible'));
    }
    if(input.action!=='select'||!current.visible)throw Error('Visible take lanes are required');
    var target=input.targetIndex;
    if(target!==null&&(typeof target!=='number'||target%1!==0||target<0||target>=current.lanes.length))throw Error('Take lane index unavailable');
    var rows=lanes(header(window())),active=current.lanes.findIndex(function(l){return l.audition;});
    if(target!==null&&target!==active)press(rows[target].button);else if(target===null&&active>=0)press(rows[active].button);
    return JSON.stringify(waitFor(function(){var s=snapshot(),index=s.lanes.findIndex(function(l){return l.audition;});return s.visible&&(index<0?null:index)===target?s:null;},'Take audition selection did not verify'));
  }catch(error){return JSON.stringify({error:String(error.message||error),actionRequested:actionRequested?null:false});}
}
