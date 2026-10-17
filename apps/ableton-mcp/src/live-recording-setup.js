// Native macOS recording preparation. Count-In and Rhythm have distinct owners.
function recordingSetupFlag(value){
  if(value===true||value===1)return true;if(value===false||value===0)return false;
  throw Error('Native recording setup flag is unknown');
}
function recordingSetupCountIndex(entries){
  var labels=['None','1 Bar','2 Bars','4 Bars'];
  if(entries.length!==4||entries.some(function(e,i){return e.name!==labels[i]||e.enabled!==true||typeof e.selected!=='boolean';})||entries.filter(function(e){return e.selected;}).length!==1)throw Error('Count-In radio inventory is unavailable or ambiguous');
  return entries.findIndex(function(e){return e.selected;});
}
function recordingSetupPopupClosed(menuCount,screenIds,ownedIds){
  return menuCount===0&&Array.isArray(ownedIds)&&ownedIds.length>0&&ownedIds.every(function(id){return Number.isSafeInteger(id)&&id>0&&screenIds.indexOf(id)<0;});
}
function run(argv){
  ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
  var input=JSON.parse(argv[0]),retained=[],prepared=input.prepared||null,operationRequested=false,opened=false;
  function read(e,key){var r=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(key),r);if(error===-25212||error===-25205)return null;if(error){var failure=Error('Native accessibility read failed: '+key);failure.axError=error;throw failure;}var v=ObjC.castRefToObject(r[0]);retained.push(v);return v;}
  function get(e,key){return ObjC.unwrap(read(e,key));}
  function list(v){var a=[];if(v)for(var i=0;i<v.count;i++)a.push(v.objectAtIndex(i));return a;}
  function children(e){return list(read(e,'AXChildren'));}
  function one(a,message){if(a.length!==1)throw Error(message);return a[0];}
  function find(e,id){var matches=[],count=0;function walk(node,d){if(d>8||++count>20000)throw Error('Native tree exceeds supported bounds');if(get(node,'AXIdentifier')===id){matches.push(node);return;}children(node).forEach(function(c){walk(c,d+1);});}walk(e,0);return matches;}
  function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
  function wait(read,message){for(var i=0;i<40;i++){var value=read();if(value)return value;delay(0.05);}throw Error(message);}
  var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
  if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected the exact Live process');
  var root=$.AXUIElementCreateApplication(input.pid);
  function windows(){return list(read(root,'AXWindows'));}
  function cg(){return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))).filter(function(w){return w.kCGWindowOwnerPID===input.pid;});}
  function screenIds(){return cg().map(function(w){return Number(w.kCGWindowNumber);}).sort(function(a,b){return a-b;});}
  function foreground(){if(Number(app.active)!==1)throw Error('Live is not frontmost; no native input sent');}
  function document(w){var url=get(w,'AXDocument');if(typeof url!=='string'||!/^file:\/\//.test(url))throw Error('Saved Set identity unavailable');var file=$.NSURL.URLWithString($(url));if(Number(file.isFileURL)!==1)throw Error('Saved Set identity unavailable');var path=ObjC.unwrap(file.path.stringByResolvingSymlinksInPath),expected=ObjC.unwrap($(input.filePath).stringByResolvingSymlinksInPath);if(path!==expected)throw Error('Visible Set document changed');return path;}
  function main(){
    var all=windows();if(all.some(function(w){return get(w,'AXModal')===true||get(w,'AXSubrole')==='AXDialog'||list(read(w,'AXSheets')).length;}))throw Error('Resolve the Live modal before recording preparation');
    var w=one(all.filter(function(w){return get(w,'AXTitle')===input.setName;}),'Exact Set window unavailable');document(w);return w;
  }
  function control(w,id){return one(find(w,id),'Native transport control unavailable: '+id);}
  function mainState(){var w=main(),id=Number(one(cg().filter(function(c){return c.kCGWindowName===input.setName;}),'Exact visible Set window identity unavailable').kCGWindowNumber),
      state={mainWindowId:id,documentPath:document(w),metronome:recordingSetupFlag(get(control(w,'Transport.Metronome'),'AXValue')),
        playing:recordingSetupFlag(get(control(w,'Transport.Play'),'AXValue')),arrangement:recordingSetupFlag(get(control(w,'Transport.GlobalRecord'),'AXValue')),
        session:recordingSetupFlag(get(control(w,'Transport.SessionRecord'),'AXValue'))};
    if(state.playing||state.arrangement||state.session)throw Error('Native playback or recording changed');return state;}
  function menus(){var result=[];windows().forEach(function(w){find(w,'ContextMenu').forEach(function(m){result.push({window:w,menu:m});});});return result;}
  function menuState(menu){
    var fields=children(menu),groups=fields.filter(function(c){return get(c,'AXRole')==='AXRadioGroup';});
    if(groups.length!==3||groups.map(function(g){return get(g,'AXTitle');}).join('|')!=='Count-In|Sound|Rhythm')throw Error('Exact metronome settings groups unavailable');
    var result={groups:groups.map(function(g){var entries=children(g).map(function(r){if(get(r,'AXRole')!=='AXRadioButton')throw Error('Native radio shape changed');return {name:get(r,'AXDescription'),selected:recordingSetupFlag(get(r,'AXValue')),enabled:recordingSetupFlag(get(r,'AXEnabled'))};});if(entries.length>32||entries.filter(function(e){return e.selected;}).length!==1)throw Error('Native radio selection unknown');return {name:get(g,'AXTitle'),entries:entries};})};
    recordingSetupCountIndex(result.groups[0].entries);
    var only=one(fields.filter(function(c){return get(c,'AXRole')==='AXMenuItem'&&get(c,'AXTitle')==='Enable Only While Recording';}),'Metronome recording-only setting unavailable');
    result.onlyWhileRecording={selected:recordingSetupFlag(get(only,'AXValue')),enabled:recordingSetupFlag(get(only,'AXEnabled'))};return result;
  }
  function ownedMenu(){foreground();if(!same(mainState(),prepared.mainState)||!same(screenIds(),prepared.screenIds))throw Error('Owned recording setup window or transport changed');var m=one(menus(),'Exact owned recording setup menu unavailable');if(!same(menuState(m.menu),prepared.panelState))throw Error('Recording setup menu changed; preserve current input');return m;}
  function press(e,setting){if(get(e,'AXEnabled')!==true)throw Error('Native recording control disabled');if(setting)operationRequested=true;if($.AXUIElementPerformAction(e,$('AXPress')))throw Error('Native control request outcome unknown');}
  function closed(){return recordingSetupPopupClosed(menus().length,screenIds(),prepared.menuWindowIds);}
  function closeOwned(){ownedMenu();Application('System Events').keyCode(53);wait(closed,'Owned recording setup menu closure did not verify');}
  function openOwned(before,expectedPanel,expectedCount){
    if(!same(mainState(),before)||menus().length)throw Error('Recording setup UI changed before menu input');
    var ids=screenIds();press(control(main(),'Transport.MetronomeContextBuddy'),false);opened=true;
    var popup=wait(function(){var m=menus();return m.length===1?m[0]:null;},'Metronome settings menu unavailable'),panel=menuState(popup.menu),newIds=wait(function(){var added=screenIds().filter(function(id){return ids.indexOf(id)<0;});return added.length?added:null;},'Popup window identity unavailable');
    if(newIds.length>4||recordingSetupCountIndex(panel.groups[0].entries)!==expectedCount||expectedPanel&&!same(panel,expectedPanel))throw Error('Native metronome settings or popup identity differ');
    return {mainState:before,screenIds:screenIds(),menuWindowIds:newIds,panelState:panel};
  }
  try{
    if(input.action==='inspect'){if(menus().length)throw Error('Resolve the existing context menu first');return JSON.stringify(mainState());}
    foreground();
    if(input.action==='prepare'){
      var before=mainState();if(!same(before,input.expectedMain)||before.metronome!==input.baseline.metronome||menus().length)throw Error('Recording setup UI changed before preparation');
      prepared=openOwned(before,null,input.baseline.countInDuration.value);return JSON.stringify(prepared);
    }
    if(input.action==='cancel'){
      main();if(!menus().length){wait(closed,'Owned popup window remains visible; closure unverified');return JSON.stringify({cancelled:true,alreadyClosed:true});}
      closeOwned();return JSON.stringify({cancelled:true});
    }
    if(input.action!=='commit'||!prepared)throw Error('Unknown recording setup operation');
    var menu=ownedMenu(),target=input.target;
    if(typeof target.metronome!=='boolean'||!Number.isInteger(target.countInDuration)||target.countInDuration<0||target.countInDuration>3)throw Error('Invalid requested recording setup');
    if(recordingSetupCountIndex(prepared.panelState.groups[0].entries)!==target.countInDuration){
      var group=one(children(menu.menu).filter(function(c){return get(c,'AXRole')==='AXRadioGroup'&&get(c,'AXTitle')==='Count-In';}),'Count-In owner unavailable'),radios=children(group);
      press(radios[target.countInDuration],true);
      var expected=JSON.parse(JSON.stringify(prepared.panelState));expected.groups[0].entries.forEach(function(e,i){e.selected=i===target.countInDuration;});
      var mode=wait(function(){
        try{
          if(closed())return 'closed';
          var current=menus();if(current.length===1&&same(screenIds(),prepared.screenIds)&&same(menuState(current[0].menu),expected))return 'open';
          return null;
        }catch(failure){if(failure.axError===-25202||failure.axError===-25204)return null;throw failure;}
      },'Count-in selection did not verify');
      if(mode==='closed')Object.assign(prepared,openOwned(prepared.mainState,expected,target.countInDuration));
      else prepared.panelState=expected;
    }
    closeOwned();
    if(menus().length||!same(mainState(),prepared.mainState))throw Error('Native transport or menu changed before metronome request');
    if(target.metronome!==prepared.mainState.metronome){press(control(main(),'Transport.Metronome'),true);wait(function(){return mainState().metronome===target.metronome;},'Metronome selection did not verify');}
    return JSON.stringify({operationRequested:operationRequested,popupClosed:true,countInDuration:target.countInDuration,metronome:mainState().metronome,mainWindowId:prepared.mainState.mainWindowId});
  }catch(error){return JSON.stringify({error:String(error.message||error),operationRequested:operationRequested?null:false,prepared:prepared,requiresInspection:opened||!!prepared});}
}
