function groupingSelectionMatches(actual, expected) {
 return Array.isArray(actual) && actual.length === expected.length && JSON.stringify(actual.slice().sort()) === JSON.stringify(expected.slice().sort());
}
function groupingRangeMatches(actual, expected, focusId, ownerFocused) {
 return groupingSelectionMatches(actual, expected) && (focusId === expected[expected.length - 1] || ownerFocused === true);
}
function groupingApplicationWindows(listed, main, focused, equal) {
 var windows=listed.slice();
 [main,focused].forEach(function(window){if(window&&!windows.some(function(existing){return equal(existing,window);}))windows.push(window);});
 return windows;
}
function ungroupHeaderId(rows, visible, target) {
 function label(row, native) {
  return row.name === native.name || /^track-(0|[1-9][0-9]*)$/.test(native.trackId) && native.name === String(Number(native.trackId.slice(6)) + 1) + '-' + row.name;
 }
 if(!Array.isArray(rows)||!Array.isArray(visible)||!visible.length||visible.length>256||rows.length!==visible.length||!Number.isInteger(target.visibleIndex)||target.visibleIndex<0||target.visibleIndex>=visible.length)return null;
 if(rows.some(function(row,i){return row.isGroup!==visible[i].isGroup||!label(row,visible[i]);}))return null;
 var native=visible[target.visibleIndex],row=rows[target.visibleIndex];
 return native.trackId===target.trackId&&native.name===target.name&&native.isGroup===true&&/\.GroupTrack(?:\[[0-9]+\])?\.TitleBar$/.test(row.id)?row.id:null;
}
function run(argv) {
 ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
 var input=JSON.parse(argv[0]),retained=[],prepared=input.prepared||null,opened=false,groupRequested=false,command=input.operation==='ungroup'?'Ungroup Tracks':'Group Tracks';
 if(input.operation!==undefined&&input.operation!=='ungroup')throw Error('Invalid track operation');
 function read(e,k){var r=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(k),r);if(error===-25212||error===-25205)return null;if(error)throw Error('Native accessibility unavailable: '+k);var v=ObjC.castRefToObject(r[0]);retained.push(v);return v;}
 function list(v){var a=[];if(v)for(var i=0;i<v.count;i++)a.push(v.objectAtIndex(i));return a;}
 function get(e,k){return ObjC.unwrap(read(e,k));}
 function one(a,m){if(a.length!==1)throw Error(m);return a[0];}
 function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
 function find(e,id){var found=[],count=0;function walk(e,d){if(d>9||++count>20000)throw Error('Native tree exceeds supported bounds');if(get(e,'AXIdentifier')===id){found.push(e);return;}list(read(e,'AXChildren')).forEach(function(c){walk(c,d+1);});}walk(e,0);return found;}
 var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
 if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected exact Live process');
 var root=$.AXUIElementCreateApplication(input.pid);
 function foreground(){if(get(root,'AXFrontmost')!==true)throw Error('Live is not frontmost');}
 function windows(){return groupingApplicationWindows(list(read(root,'AXWindows')),read(root,'AXMainWindow'),read(root,'AXFocusedWindow'),function(a,b){return !!$.CFEqual(a,b);});}
 function main(){var all=windows();if(all.some(function(w){return get(w,'AXModal')===true||get(w,'AXSubrole')==='AXDialog'||list(read(w,'AXSheets')).length;}))throw Error('Resolve native dialog before grouping');var w=one(all.filter(function(w){return get(w,'AXTitle')===input.setName;}),'Exact Set window unavailable'),value=get(w,'AXDocument');if(typeof value!=='string'||!/^file:\/\//.test(value))throw Error('Saved Set document unavailable');var url=$.NSURL.URLWithString($(value));if(Number(url.isFileURL)!==1||ObjC.unwrap(url.path.stringByResolvingSymlinksInPath)!==ObjC.unwrap($(input.filePath).stringByResolvingSymlinksInPath))throw Error('Saved Set document changed');return w;}
 function cg(visible){return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(visible?1:0,0))).filter(function(w){return w.kCGWindowOwnerPID===input.pid;});}
 function screenIds(){return cg(true).map(function(w){return Number(w.kCGWindowNumber);}).sort(function(a,b){return a-b;});}
 function stopped(){['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].forEach(function(id){var v=get(one(find(main(),id),'Native transport control unavailable'),'AXValue');if(v!==0&&v!==false)throw Error('Native playback or recording changed');});}
 function mainState(){stopped();return {mainWindowId:Number(one(cg(false).filter(function(w){return w.kCGWindowName===input.setName;}),'Set window identity unavailable').kCGWindowNumber)};}
 function ungroupRows(view,window){var rows=[],count=0;function walk(e,d){if(d>9||++count>20000)throw Error('Native header inventory exceeds bounds');var id=get(e,'AXIdentifier');if(get(e,'AXRole')==='AXRow'&&typeof id==='string'&&id.indexOf(view+'.')===0&&/\.(?:GroupTrack(?:\[[0-9]+\])?|Track\[[0-9]+\])\.TitleBar$/.test(id)){rows.push({element:e,id:id,name:get(one(find(e,id+'.TitleBarEditField'),'Track label unavailable'),'AXValue'),isGroup:/\.GroupTrack(?:\[[0-9]+\])?\.TitleBar$/.test(id)});return;}list(read(e,'AXChildren')).forEach(function(c){walk(c,d+1);});}walk(window,0);return rows;}
 function target(t){
  if(input.operation==='ungroup'){var matches=[],window=main();['SessionView','ArrangementView'].forEach(function(view){var rows=ungroupRows(view,window),id=ungroupHeaderId(rows,input.visibleTracks,t);if(id)matches.push(one(rows.filter(function(r){return r.id===id;}),'Exact Group header unavailable').element);});return one(matches,'Native visible track order or Group header changed');}
  var rows=[];['SessionView','ArrangementView'].forEach(function(view){find(main(),view+t.uiPath+'.TitleBar').forEach(function(e){rows.push(e);});});var row=one(rows,'Requested track must have one native header'),id=get(row,'AXIdentifier');if(get(one(find(row,id+'.TitleBarEditField'),'Track label unavailable'),'AXValue')!==t.name)throw Error('Native track name changed');return row;
 }
 function selected(){var parent=read(target(input.targets[0]),'AXParent');if(get(parent,'AXRole')!=='AXOutline')throw Error('Native track selection owner unavailable');return list(read(parent,'AXSelectedRows')).map(function(e){return get(e,'AXIdentifier');});}
 function menus(){var a=[];windows().forEach(function(w){['ContextMenu','ChooserPopUp'].forEach(function(id){find(w,id).forEach(function(m){a.push(m);});});});return a;}
 function menuState(menu){return list(read(menu,'AXChildren')).map(function(e){return {role:get(e,'AXRole'),title:get(e,'AXTitle'),enabled:get(e,'AXEnabled')};});}
 function wait(check,attempts){for(var i=0;i<attempts;i++){try{if(check())return true;}catch(error){}delay(0.05);}return false;}
 function ids(){return input.targets.map(function(t){return get(target(t),'AXIdentifier');});}
 function selectRange(){
  var expected=ids(),row=target(input.targets[0]),parent=read(row,'AXParent'),session=expected[0].indexOf('SessionView.')===0;
  if(get(parent,'AXRole')!=='AXOutline')throw Error('Selection owner unavailable');
  var inventory=list(read(parent,'AXChildren')).filter(function(e){return get(e,'AXRole')==='AXRow';}).map(function(e){return get(e,'AXIdentifier');}),start=inventory.indexOf(expected[0]),screens=screenIds();
  if(start<0||!same(inventory.slice(start,start+expected.length),expected))throw Error('Headers not consecutive');
  function selection(){return list(read(parent,'AXSelectedRows')).map(function(e){return get(e,'AXIdentifier');});}
  function focus(){return get(read(root,'AXFocusedUIElement'),'AXIdentifier');}
  function key(code,shift){foreground();if(!same(screenIds(),screens))throw Error('Visible windows changed during selection');Application('System Events').keyCode(code,shift?{using:['shift down']}:{});}
  if($.AXUIElementSetAttributeValue(row,$('AXFocused'),$(true)))throw Error('Focus request failed');
  if(focus()!==expected[0]&&!$.CFEqual(read(root,'AXFocusedUIElement'),parent))throw Error('Header focus unavailable');
  stopped();key(session?124:125,false);if(!wait(function(){var id=focus();return inventory.indexOf(id)>=0&&groupingSelectionMatches(selection(),[id]);},40))throw Error('Exclusive navigation did not verify');
  for(var step=0;focus()!==expected[0]&&step<inventory.length;step++){
   var at=inventory.indexOf(focus());if(at<0)throw Error('Focus left inventory');var next=at+(at<start?1:-1);key(session?(next>at?124:123):(next>at?125:126),false);if(!wait(function(){return focus()===inventory[next]&&groupingSelectionMatches(selection(),[inventory[next]]);},40))throw Error('Exclusive selection did not verify');
  }
  if(focus()!==expected[0]||!groupingSelectionMatches(selection(),[expected[0]]))throw Error('Exact Group selection failed');
  for(var i=1;i<expected.length;i++){key(session?124:125,true);if(!wait(function(){var focused=read(root,'AXFocusedUIElement');return groupingRangeMatches(selection(),expected.slice(0,i+1),get(focused,'AXIdentifier'),!!$.CFEqual(focused,parent));},40))throw Error('Exact range did not verify');}
  stopped();
 }
 function owned(){foreground();if(!same(mainState(),prepared.main)||!same(screenIds(),prepared.screenIds)||!groupingSelectionMatches(selected(),prepared.selection)||!groupingSelectionMatches(ids(),prepared.selection))throw Error('Owned grouping UI or selection changed');var menu=one(menus(),'Owned track popup unavailable');if(!same(menuState(menu),prepared.menu))throw Error('Owned grouping menu changed');return menu;}
 function closed(){var visible=screenIds();return menus().length===0&&prepared.menuWindowIds.length>0&&prepared.menuWindowIds.every(function(id){return visible.indexOf(id)<0;});}
 try {
  if(input.action==='inspect'){if(menus().length)throw Error('Resolve existing popup before grouping');ids();return JSON.stringify(mainState());}
  foreground();
  if(input.action==='prepare'){
   if(menus().length||!same(mainState(),input.expectedMain))throw Error('Native grouping UI changed');selectRange();var selection=selected(),expected=ids();if(!groupingSelectionMatches(selection,expected))throw Error('Exact requested track selection changed');
   var beforeIds=screenIds();if($.AXUIElementPerformAction(target(input.targets[0]),$('AXShowMenu')))throw Error('Track menu request outcome unknown');opened=true;
   var menu=one(menus(),'Track grouping menu unavailable'),newIds=[];wait(function(){newIds=screenIds().filter(function(id){return beforeIds.indexOf(id)<0;});return newIds.length>0;},40);if(!newIds.length||newIds.length>4)throw Error('Grouping popup identity unavailable');
   prepared={main:mainState(),selection:selection,screenIds:screenIds(),menuWindowIds:newIds,menu:menuState(menu)};
   one(prepared.menu.filter(function(e){return e.role==='AXMenuItem'&&String(e.title).split(',')[0]===command&&e.enabled===true;}),'Explicit enabled '+command+' command unavailable');return JSON.stringify(prepared);
  }
  if(!prepared)throw Error('Owned grouping preparation required');
  if(input.action==='cancel'){if(closed())return JSON.stringify({cancelled:true,alreadyClosed:true});owned();Application('System Events').keyCode(53);if(!wait(closed,40))throw Error('Owned grouping menu closure unverified');return JSON.stringify({cancelled:true});}
  if(input.action!=='commit')throw Error('Invalid grouping action');var menu=owned(),item=one(list(read(menu,'AXChildren')).filter(function(e){return get(e,'AXRole')==='AXMenuItem'&&String(get(e,'AXTitle')).split(',')[0]===command&&get(e,'AXEnabled')===true;}),'Exact enabled grouping command unavailable');
  groupRequested=null;if($.AXUIElementPerformAction(item,$('AXPress')))throw Error('Native grouping command outcome unknown');groupRequested=true;
  var idle=wait(function(){return closed()&&same(mainState(),prepared.main);},100);return JSON.stringify({groupRequested:true,popupClosed:closed(),uiIdle:idle});
 }catch(error){return JSON.stringify({error:String(error.message||error),groupRequested:groupRequested,prepared:prepared,requiresInspection:opened||!!prepared});}
}
