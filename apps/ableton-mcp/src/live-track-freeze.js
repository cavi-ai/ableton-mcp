function trackFreezeMenuTitle(frozen){return frozen?'Freeze Track':'Unfreeze Track';}
function trackFreezeSelection(ids,target){return Array.isArray(ids)&&ids.length===1&&ids[0]===target;}
function run(argv){
 ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
 var input=JSON.parse(argv[0]),retained=[],prepared=input.prepared||null,freezeRequested=false,opened=false;
 function read(e,k){var r=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(k),r);if(error===-25212||error===-25205)return null;if(error)throw Error('Native accessibility unavailable: '+k);var v=ObjC.castRefToObject(r[0]);retained.push(v);return v;}
 function list(v){var a=[];if(v)for(var i=0;i<v.count;i++)a.push(v.objectAtIndex(i));return a;}
 function get(e,k){return ObjC.unwrap(read(e,k));}
 function one(a,message){if(a.length!==1)throw Error(message);return a[0];}
 function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
 function find(e,id){var found=[],count=0;function walk(e,d){if(d>9||++count>20000)throw Error('Native tree exceeds supported bounds');if(get(e,'AXIdentifier')===id){found.push(e);return;}list(read(e,'AXChildren')).forEach(function(c){walk(c,d+1);});}walk(e,0);return found;}
 var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
 if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected exact Live process');
 var root=$.AXUIElementCreateApplication(input.pid);
 function windows(){return list(read(root,'AXWindows'));}
 function cg(visible){return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(visible?1:0,0))).filter(function(w){return w.kCGWindowOwnerPID===input.pid;});}
 function screenIds(){return cg(true).map(function(w){return Number(w.kCGWindowNumber);}).sort(function(a,b){return a-b;});}
 function foreground(){if(Number(app.active)!==1)throw Error('Live is not frontmost');}
 function main(){
  var all=windows();if(all.some(function(w){return get(w,'AXModal')===true||get(w,'AXSubrole')==='AXDialog'||list(read(w,'AXSheets')).length;}))throw Error('Resolve native dialog before freezing');
  var w=one(all.filter(function(w){return get(w,'AXTitle')===input.setName;}),'Exact Set window unavailable'),url=get(w,'AXDocument');
  if(typeof url!=='string'||!/^file:\/\//.test(url))throw Error('Saved Set document unavailable');
  var file=$.NSURL.URLWithString($(url));if(Number(file.isFileURL)!==1||ObjC.unwrap(file.path.stringByResolvingSymlinksInPath)!==ObjC.unwrap($(input.filePath).stringByResolvingSymlinksInPath))throw Error('Saved Set document changed');return w;
 }
 function control(id){return one(find(main(),id),'Native control missing: '+id);}
 function stopped(){['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].forEach(function(id){var v=get(control(id),'AXValue');if(v!==0&&v!==false)throw Error('Native playback or recording changed');});}
 function mainState(){stopped();return {mainWindowId:Number(one(cg(false).filter(function(w){return w.kCGWindowName===input.setName;}),'Exact Set window identity unavailable').kCGWindowNumber)};}
 function menus(){var found=[];windows().forEach(function(w){['ContextMenu','ChooserPopUp'].forEach(function(id){find(w,id).forEach(function(m){found.push(m);});});});return found;}
 function target(){var w=main(),rows=[];['SessionView','ArrangementView'].forEach(function(view){find(w,view+input.uiPath+'.TitleBar').forEach(function(e){rows.push(e);});});var row=one(rows,'Requested track must be visible in one view'),id=get(row,'AXIdentifier'),title=one(find(row,id+'.TitleBarEditField'),'Exact track title unavailable');if(get(title,'AXValue')!==input.trackName)throw Error('Visible track name changed');return row;}
 function selection(){var row=target(),parent=read(row,'AXParent');if(get(parent,'AXRole')!=='AXOutline')throw Error('Track selection owner unavailable');return list(read(parent,'AXSelectedRows')).map(function(e){return get(e,'AXIdentifier');});}
 function selectExclusive(){
  var row=target(),parent=read(row,'AXParent'),id=get(row,'AXIdentifier'),session=id.indexOf('SessionView.')===0;
  if(get(parent,'AXRole')!=='AXOutline')throw Error('Track navigation owner unavailable');
  var ids=list(read(parent,'AXChildren')).filter(function(e){return get(e,'AXRole')==='AXRow';}).map(function(e){return get(e,'AXIdentifier');});
  if(ids.indexOf(id)<0||ids.length>512||ids.some(function(x){return typeof x!=='string'||!x;})||ids.some(function(x,i){return ids.indexOf(x)!==i;}))throw Error('Visible track navigation inventory is ambiguous');
  if($.AXUIElementSetAttributeValue(row,$('AXFocused'),$(true)))throw Error('Track header focus unavailable');
  function focus(){return get(read(root,'AXFocusedUIElement'),'AXIdentifier');}
  if(focus()!==id)throw Error('Exact track header focus did not verify');
  // AXSelectedRows does not clear Live's internal multi-selection. Native
  // header navigation does; the singular menu command is checked afterward.
  stopped();Application('System Events').keyCode(session?123:126);delay(0.1);
  for(var step=0;step<512;step++){
   foreground();if(menus().length)throw Error('Popup appeared during track selection');stopped();
   var current=focus(),index=ids.indexOf(current),targetIndex=ids.indexOf(id);if(index<0)throw Error('Track navigation focus left the header inventory');
   if(current===id){if(!trackFreezeSelection(selection(),id))throw Error('Single-track header selection did not verify');return;}
   var delta=targetIndex>index?1:-1,expected=ids[index+delta];
   Application('System Events').keyCode(session?(delta>0?124:123):(delta>0?125:126));
   if(!wait(function(){return focus()===expected;},40))throw Error('Native track navigation did not reach the expected header');
  }
  throw Error('Track navigation exceeds supported bounds');
 }
 function menuState(menu){return list(read(menu,'AXChildren')).map(function(e){return {role:get(e,'AXRole'),title:get(e,'AXTitle'),enabled:get(e,'AXEnabled')};});}
 function owned(){foreground();if(!same(mainState(),prepared.main)||!same(screenIds(),prepared.screenIds)||!same(selection(),prepared.selection))throw Error('Owned freeze UI or track selection changed');var menu=one(menus(),'Exact owned track menu unavailable');if(!same(menuState(menu),prepared.menu))throw Error('Track menu changed');return menu;}
 function closed(){return menus().length===0&&prepared.menuWindowIds.length>0&&prepared.menuWindowIds.every(function(id){return screenIds().indexOf(id)<0;});}
 function wait(check,attempts){for(var i=0;i<attempts;i++){try{if(check())return true;}catch(error){}delay(0.05);}return false;}
 try{
  if(input.action==='inspect'){if(menus().length)throw Error('Resolve existing native popup first');target();return JSON.stringify(mainState());}
  foreground();
  if(input.action==='prepare'){
   if(menus().length||!same(mainState(),input.expectedMain))throw Error('Freeze UI changed before preparation');selectExclusive();var row=target();
   var ids=selection();if(!trackFreezeSelection(ids,get(row,'AXIdentifier')))throw Error('Exact single-track selection did not verify');
   var beforeIds=screenIds();if($.AXUIElementPerformAction(row,$('AXShowMenu')))throw Error('Track menu request outcome unknown');opened=true;
   var menu=one(menus(),'Track context menu unavailable'),newIds=[];wait(function(){newIds=screenIds().filter(function(id){return beforeIds.indexOf(id)<0;});return newIds.length>0;},40);
   if(!newIds.length||newIds.length>4)throw Error('Track popup identity unavailable');
   prepared={main:mainState(),selection:ids,screenIds:screenIds(),menuWindowIds:newIds,menu:menuState(menu)};
   var title=trackFreezeMenuTitle(!input.frozen);one(prepared.menu.filter(function(e){return e.role==='AXMenuItem'&&String(e.title).split(',')[0]===title&&e.enabled===true;}),'Explicit enabled freeze command unavailable');
   return JSON.stringify(prepared);
  }
  if(!prepared)throw Error('Owned freeze preparation required');
  if(input.action==='cancel'){
   if(closed())return JSON.stringify({cancelled:true,alreadyClosed:true});owned();Application('System Events').keyCode(53);if(!wait(closed,40))throw Error('Owned track popup closure unverified');return JSON.stringify({cancelled:true});
  }
  if(input.action!=='commit'||typeof input.frozen!=='boolean')throw Error('Invalid freeze action');
  var menu=owned(),title=trackFreezeMenuTitle(input.frozen),item=one(list(read(menu,'AXChildren')).filter(function(e){return get(e,'AXRole')==='AXMenuItem'&&String(get(e,'AXTitle')).split(',')[0]===title&&get(e,'AXEnabled')===true;}),'Exact enabled freeze command unavailable');
  freezeRequested=null;if($.AXUIElementPerformAction(item,$('AXPress')))throw Error('Native freeze request outcome unknown');freezeRequested=true;
  var idle=wait(function(){return closed()&&same(mainState(),prepared.main);},400);
  return JSON.stringify({freezeRequested:true,popupClosed:closed(),uiIdle:idle});
 }catch(error){return JSON.stringify({error:String(error.message||error),freezeRequested:freezeRequested,prepared:prepared,requiresInspection:opened||!!prepared});}
}
