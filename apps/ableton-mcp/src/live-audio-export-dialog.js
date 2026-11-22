// JavaScript for Automation. Retained native AX elements survive chooser-window insertions.
function resolveRenderedTrackMenu(menu,target,requireSelected){
  if(!Array.isArray(menu)||!target||!Array.isArray(target.menuTitles)||menu.length!==target.menuTitles.length||
     !Number.isInteger(target.menuIndex)||target.menuIndex<3||target.menuIndex>=menu.length)throw Error('Native rendered-track inventory changed');
  var titles=menu.map(function(item){
    if(!item||typeof item.title!=='string'||typeof item.selected!=='boolean')throw Error('Native rendered-track inventory is unavailable');
    return item.selected?item.title.replace(/^✔\s*/,''):item.title;
  });
  if(JSON.stringify(titles)!==JSON.stringify(target.menuTitles))throw Error('Native rendered-track inventory changed');
  if(titles[target.menuIndex]!==target.name||menu[target.menuIndex].enabled!==true)throw Error('Native rendered-track target is unavailable');
  if(requireSelected&&(!menu[target.menuIndex].selected||menu.filter(function(item){return item.selected;}).length!==1))throw Error('Native rendered-track selection changed');
  return target.menuIndex;
}

function run(argv){
  ObjC.import("CoreGraphics");ObjC.import("ApplicationServices");ObjC.import("AppKit");
  var input=JSON.parse(argv[0]),events=Application("System Events");
  var processes=events.applicationProcesses.whose({unixId:input.pid})();
  if(processes.length!==1||processes[0].bundleIdentifier()!=="com.ableton.live")throw Error("Expected the exact Live process");
  var process=processes[0],app=$.AXUIElementCreateApplication(input.pid),retained=[];
  function read(e,key){var ref=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(key),ref);if(error===-25212||error===-25205)return null;if(error!==0)throw Error("Native accessibility read failed: "+key);var result=ObjC.castRefToObject(ref[0]);retained.push(result);return result;}
  function value(e,key){var raw=read(e,key);return raw===null?null:ObjC.unwrap(raw);}
  function items(array){var result=[];if(array)for(var i=0;i<array.count;i++)result.push(array.objectAtIndex(i));return result;}
  function children(e){return items(read(e,"AXChildren"));}
  function windows(){return items(read(app,"AXWindows"));}
  // Controls are pressed through accessibility. A key is used only where no accessibility action exists,
  // right after Live is verified frontmost; the activation is retried a bounded number of times.
  var exportPress={steps:{},keys:[],activations:0};
  function route(step,kind){var current=exportPress.steps[step];if(!current)exportPress.steps[step]=kind;else if(current.split("+").indexOf(kind)===-1)exportPress.steps[step]=current+"+"+kind;}
  function activate(){$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid).activateWithOptions(3);}
  function frontApp(){try{return ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)||null;}catch(error){return null;}}
  function foreground(){
    for(var attempt=0;attempt<3&&!process.frontmost();attempt++){activate();exportPress.activations++;for(var i=0;i<20&&!process.frontmost();i++)delay(0.05);}
    if(!process.frontmost())throw Error("Live is not foreground ("+(frontApp()||"another app")+" is) after "+attempt+" activations; no key was sent");
  }
  // The focus check is the last step before a key, so the key cannot reach another app.
  function keyed(site,step){foreground();exportPress.keys.push(site);route(step||site,"key");}
  function wait(read,message,count,seconds){
    var end=seconds?Date.now()+seconds*1000:0;
    for(var i=0;i<(count||40);i++){var result=read();if(result)return result;if(end&&Date.now()>end)break;delay(0.05);}
    if(message===null)return null;throw Error(message);
  }
  function namedWindow(title){var matches=allWindows().filter(function(w){return value(w,"AXTitle")===title;});if(matches.length!==1)throw Error("Expected one native "+title+" window");return matches[0];}
  function windowId(w){
    var title=value(w,"AXTitle"),same=allWindows().filter(function(current){return value(current,"AXTitle")===title;});
    if(same.length!==1||!$.CFEqual(same[0],w))throw Error("Native window changed");
    var id=cgWindowId(title);if(!Number.isInteger(id))throw Error("Native window identity is unavailable or ambiguous");return id;
  }
  function savePanels(){return windows().filter(function(w){return value(w,"AXIdentifier")==="save-panel";});}
  // AXWindows can omit the export Save panel; Live's focused window still names it.
  function openSavePanels(){
    var listed=savePanels();if(listed.length)return {panels:listed,source:"windows"};
    var focused=read(app,"AXFocusedWindow");
    if(focused&&value(focused,"AXIdentifier")==="save-panel")return {panels:[focused],source:"focusedWindow"};
    return {panels:[],source:null};
  }
  function press(e,timeout){if(value(e,"AXEnabled")!==true)throw Error("Native control is disabled");if(timeout)$.AXUIElementSetMessagingTimeout(e,timeout);return $.AXUIElementPerformAction(e,$("AXPress"));}
  // AXWindows can omit Live's dialogs; its focused window stays readable.
  function allWindows(){var list=windows(),focused=read(app,"AXFocusedWindow");if(focused&&!list.some(function(w){return $.CFEqual(w,focused);}))list.push(focused);return list;}
  function sheetsOf(w){var list=items(read(w,"AXSheets"));children(w).forEach(function(c){if(value(c,"AXRole")==="AXSheet"&&!list.some(function(s){return $.CFEqual(s,c);}))list.push(c);});return list;}
  function onscreenWindow(id){return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))).some(function(item){return item.kCGWindowOwnerPID===input.pid&&item.kCGWindowNumber===id;});}
  function cgWindowId(title){
    if(typeof title!=="string"||!title)return null;
    var list=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))).filter(function(item){return item.kCGWindowOwnerPID===input.pid&&item.kCGWindowName===title;});
    var visible=list.filter(function(item){return item.kCGWindowIsOnscreen===true;});if(visible.length)list=visible;
    return list.length===1?list[0].kCGWindowNumber:null;
  }
  // Window evidence for a reply; nothing is pressed or focused.
  function observation(){
    function brief(w){return w?{title:value(w,"AXTitle"),subrole:value(w,"AXSubrole")}:null;}
    var cg=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))).filter(function(w){return w.kCGWindowOwnerPID===input.pid&&w.kCGWindowLayer===0;});
    return {axWindows:windows().length,focusedWindow:brief(read(app,"AXFocusedWindow")),mainWindow:brief(read(app,"AXMainWindow")),
      cgWindows:cg.length,cgOnscreen:cg.filter(function(w){return w.kCGWindowIsOnscreen===true;}).length,
      cgTitles:cg.slice(0,12).map(function(w){return {title:typeof w.kCGWindowName==="string"?w.kCGWindowName:null,onscreen:w.kCGWindowIsOnscreen===true};}),
      liveFrontmost:process.frontmost(),frontmost:frontApp(),hidden:liveHidden(),exportMenuEnabled:menuEnabled()};
  }
  function liveHidden(){try{return ObjC.unwrap($.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid).hidden)===true;}catch(error){return null;}}
  function menuEnabled(){var item=exportMenuItem();return item?value(item,"AXEnabled")===true:null;}
  // File > Export Audio/Video through the menu bar's accessibility tree, without opening the menu.
  function exportMenuItem(){
    try{
      var bar=read(app,"AXMenuBar");if(!bar)return null;
      var file=children(bar).filter(function(item){return value(item,"AXTitle")==="File";});if(file.length!==1)return null;
      var menu=children(file[0]).filter(function(item){return value(item,"AXRole")==="AXMenu";});if(menu.length!==1)return null;
      var found=children(menu[0]).filter(function(item){return /^Export Audio\/Video(\.\.\.|…)$/.test(String(value(item,"AXTitle")));});
      return found.length===1?found[0]:null;
    }catch(error){return null;}
  }
  function walkControls(root,visit){
    var seen=0;(function walk(e,depth){
      if(depth>6||++seen>400)return;var role=value(e,"AXRole");if(depth&&role==="AXSheet")return;visit(e,role);
      if(["AXScrollArea","AXOutline","AXTable","AXBrowser"].indexOf(role)===-1)children(e).forEach(function(c){walk(c,depth+1);});
    })(root,0);
  }
  // Identity is read only; nothing is pressed or focused.
  function describe(e,parentTitle){
    var buttons=[],texts=[],ids={},message=null;
    walkControls(e,function(node,role){
      var id=value(node,"AXIdentifier");if(typeof id==="string")ids[id]=(ids[id]||0)+1;
      if(role==="AXButton"){var name=value(node,"AXTitle")||value(node,"AXDescription")||id;if(typeof name==="string"&&name)buttons.push(name);}
      else if(role==="AXStaticText"){var text=value(node,"AXValue");if(typeof text!=="string"||!text)return;if(id==="_messageTextField")message=text;if(texts.length<4)texts.push(text.slice(0,240));}
    });
    var title=value(e,"AXTitle"),subrole=value(e,"AXSubrole"),identifier=value(e,"AXIdentifier"),sheet=value(e,"AXRole")==="AXSheet",identity="unknown";
    if(!sheet&&title==="Export Audio/Video"&&subrole==="AXDialog"&&ids["Base.FinalButtonsBox.CancelButton"]===1&&ids["Base.FinalButtonsBox.ExportButton"]===1)identity="exportAudioVideo";
    else if(!sheet&&identifier==="save-panel"&&message==="Save Audio File As:"&&ids.CancelButton===1)identity="exportSavePanel";
    var info={identity:identity,title:typeof title==="string"?title:null,subrole:typeof subrole==="string"?subrole:null,
      identifier:typeof identifier==="string"?identifier:null,modal:value(e,"AXModal")===true,sheet:sheet,
      sheetCount:sheet?0:sheetsOf(e).length,buttons:buttons,texts:texts,windowId:sheet?null:cgWindowId(title)};
    if(sheet)info.parentTitle=parentTitle;
    return info;
  }
  function nativeDialogs(){
    var found=[];
    allWindows().forEach(function(w){
      var title=value(w,"AXTitle");title=typeof title==="string"?title:null;
      if(value(w,"AXSubrole")==="AXDialog"||value(w,"AXModal")===true)found.push({element:w,info:describe(w)});
      sheetsOf(w).forEach(function(s){found.push({element:s,info:describe(s,title)});});
    });
    // The window list and the focused window can both report one window; a shared window id is one dialog.
    return found.filter(function(entry,i){var id=entry.info.windowId;return !Number.isInteger(id)||found.findIndex(function(other){return other.info.windowId===id;})===i;});
  }
  function infos(found){return found.map(function(entry){return entry.info;});}
  // An unsaved Set's main window has no AXDocument; AXMainWindow names it when AXWindows omits it.
  function documentWindow(list){var main=read(app,"AXMainWindow");return list.concat(main?[main]:[]).some(function(w){return value(w,"AXSubrole")==="AXStandardWindow";});}
  function dialogKey(info){return JSON.stringify([info.identity,info.windowId,info.title,info.sheetCount]);}
  function cancelDialog(entry){
    var target=entry.info,cancelId=target.identity==="exportSavePanel"?"CancelButton":"Base.FinalButtonsBox.CancelButton",buttons=[];
    var same=nativeDialogs().filter(function(other){return $.CFEqual(other.element,entry.element);});
    if(same.length!==1||dialogKey(same[0].info)!==dialogKey(target)||same[0].info.sheetCount||!Number.isInteger(target.windowId))throw Error("Native "+target.identity+" window changed; no Cancel was pressed");
    walkControls(entry.element,function(node,role){if(role==="AXButton"&&value(node,"AXIdentifier")===cancelId)buttons.push(node);});
    if(buttons.length!==1)throw Error("Native "+target.identity+" Cancel is unavailable; no Cancel was pressed");
    if(press(buttons[0])!==0)throw Error("Native "+target.identity+" Cancel outcome is unknown");
    wait(function(){return !nativeDialogs().some(function(other){return $.CFEqual(other.element,entry.element);})&&!onscreenWindow(target.windowId);},"Native "+target.identity+" closure is unverified");
    return target;
  }
  // Live hides Export Audio/Video while its Save panel is open and shows it again after that panel closes.
  function reshownExport(){
    for(var i=0;i<60;i++){var found=nativeDialogs().filter(function(entry){return entry.info.identity==="exportAudioVideo";});if(found.length)return found;delay(0.05);}
    return [];
  }
  function exportOpen(){return allWindows().some(function(w){return value(w,"AXTitle")==="Export Audio/Video";});}
  if(input.action==="inspect"){var found=nativeDialogs();return JSON.stringify({blocked:found.length>0,uiComplete:!found.length&&documentWindow(allWindows()),dialogs:infos(found),observation:observation()});}
  // Cancels a leftover export dialog without prior ownership, only on the planned identities.
  if(input.action==="cancelLeftover"){
    var planned=input.targets,current=nativeDialogs();
    if(!Array.isArray(planned)||!planned.length||current.length!==planned.length||current.some(function(entry,i){return entry.info.identity==="unknown"||!Number.isInteger(entry.info.windowId)||dialogKey(entry.info)!==dialogKey(planned[i]);}))
      throw Error("Native dialogs changed; no Cancel was pressed");
    var order=current.filter(function(entry){return entry.info.identity==="exportSavePanel";}).concat(current.filter(function(entry){return entry.info.identity==="exportAudioVideo";}));
    var closed=order.map(cancelDialog);
    if(closed.some(function(info){return info.identity==="exportSavePanel";})&&!closed.some(function(info){return info.identity==="exportAudioVideo";})){
      var parent=reshownExport();if(parent.length===1)closed.push(cancelDialog(parent[0]));
    }
    var remaining=nativeDialogs();
    return JSON.stringify({cancelled:true,closed:closed,blocked:remaining.length>0,dialogs:infos(remaining)});
  }
  if(input.action==="status"){
    // A rendering Live can refuse reads; that observation is incomplete, never complete.
    try{
      var all=allWindows(),blocked=all.some(function(w){return value(w,"AXSubrole")==="AXDialog"||value(w,"AXModal")===true||sheetsOf(w).length>0;});
      return JSON.stringify({uiComplete:!blocked&&documentWindow(all)});
    }catch(error){return JSON.stringify({uiComplete:false,observationError:String(error.message||error)});}
  }
  if(input.action==="commit"){
    // A press that opens Live's synchronous Save panel holds its reply; every read here is bounded.
    $.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(),2);
    wait(function(){try{return windowId(namedWindow("Export Audio/Video"))===input.windowId;}catch(error){return false;}},"Prepared Export window is not observable");
  }
  var window,controls={};
  function cache(){controls={};function walk(e,depth){if(depth>5)return;var id=value(e,"AXIdentifier");if(id){if(controls[id])throw Error("Ambiguous native export control");controls[id]=e;}children(e).forEach(function(c){walk(c,depth+1);});}walk(window,0);}
  function control(id){if(!controls[id])throw Error("Native export control unavailable: "+id);return controls[id];}
  var ids={track:"Base.RenderedTrack",rate:"Base.SampleRateBox.SampleRate",type:"Base.FileTypeBox.FileType",
    bits:"Base.FileTypeOptionsBox.FileTypeOptionsCardView.BitDepthBox.BitDepth",dither:"Base.FileTypeOptionsBox.FileTypeOptionsCardView.DitherTypeBox.DitherType",
    pcm:"Base.EncodePcmBox.EncodePcm",mp3:"Base.EncodeMp3Box.EncodeMp3",analysis:"Base.AnalysisFileBox.CreateAnalysisFile",
    mono:"Base.ConvertToMonoBox.ConvertToMono",normalize:"Base.NormalizeBox.Normalize",loop:"Base.RenderAsLoopBox.RenderAsLoop",
    returns:"Base.RenderStemsBox.RenderStems",video:"Base.VideoOptionsCardView.CreateVideoBox.CreateVideo"};
  ["Bars","Beats","Subdivisions"].forEach(function(part,i){ids["start"+i]="Base.RenderStartBox.RenderStart."+part;ids["length"+i]="Base.RenderLengthBox.RenderLength."+part;});
  function state(){var result={};Object.keys(ids).forEach(function(key){var c=control(ids[key]);result[key]={value:value(c,"AXValue"),enabled:value(c,"AXEnabled")};});return result;}
  function sameState(expected){if(JSON.stringify(state())!==JSON.stringify(expected))throw Error("Native export settings changed; preserve current input");}
  function sameWindow(){if(windowId(window)!==input.windowId)throw Error("Native Export window changed");}
  function choiceMenus(){
    var menus=[];allWindows().filter(function(w){return value(w,"AXSubrole")==="AXUnknown";}).forEach(function(w){function walk(e,d){if(d>3)return;if(value(e,"AXIdentifier")==="ChooserPopUp")menus.push(e);else children(e).forEach(function(c){walk(c,d+1);});}walk(w,0);});
    return menus;
  }
  function selectRenderedTrack(target,requireSelected){
    sameWindow();press(control(ids.track));var menus=choiceMenus();
    if(menus.length!==1)throw Error('Native rendered-track chooser is ambiguous');
    var menu=menus[0],entries=children(menu).filter(function(e){return value(e,'AXRole')==='AXMenuItem';});
    try{
      var index=resolveRenderedTrackMenu(entries.map(function(e){return {title:value(e,'AXTitle'),selected:value(e,'AXValue'),enabled:value(e,'AXEnabled')};}),target,requireSelected);
      sameWindow();press(entries[index]);
      wait(function(){cache();return String(value(control(ids.track),'AXValue'))===target.name;},'Native rendered-track readback changed');
    }catch(error){
      var current=choiceMenus();
      if(current.length===1&&$.CFEqual(current[0],menu)){
        if($.AXUIElementPerformAction(menu,$("AXCancel"))===0&&wait(function(){return !choiceMenus().some(function(m){return $.CFEqual(m,menu);});},null,20))route("chooser","axCancel");
        else try{sameWindow();keyed("chooserEscape","chooser");events.keyCode(53);}catch(focusError){/* The original error stays authoritative. */}
      }
      throw error;
    }
  }
  var owned=null;
  if(input.action==="prepare"){
    var blockers=nativeDialogs();
    if(blockers.length)return JSON.stringify({prepared:false,blocked:true,error:"Resolve the existing Live dialog before audio export",dialogs:infos(blockers)});
    exportPress.before=observation();
    try{
      var item=exportMenuItem();
      if(item){
        // A disabled item means Live is in a modal state; its shortcut is disabled too, so no key is sent.
        if(value(item,"AXEnabled")!==true)throw Error("Live's Export Audio/Video menu item is disabled; no key was sent");
        // A menu press that waits for the opened dialog times out; the window itself is observed below.
        var opened=press(item,1);exportPress.menuResult=opened;
        if(opened!==0&&opened!==-25204)throw Error("Native Export Audio/Video menu press failed ("+opened+")");
        route("open","menu");
      }else{keyed("open");events.keystroke("r",{using:["command down","shift down"]});}
      window=wait(function(){try{return namedWindow("Export Audio/Video");}catch(error){return null;}},"Native Export dialog did not appear",100,10);
      input.windowId=wait(function(){try{return windowId(window);}catch(error){return null;}},"Native Export window identity is unavailable",100,10);cache();owned=state();
    }catch(error){
      try{exportPress.afterOpen=observation();}catch(readError){exportPress.afterOpen={observationError:String(readError.message||readError)};}
      return JSON.stringify({prepared:false,error:String(error.message||error),exportPress:exportPress});
    }
    function ready(){sameWindow();sameState(owned);}
    function changed(){cache();owned=state();}
    function current(key){cache();return value(control(ids[key]),"AXValue");}
    function readback(key,next){wait(function(){sameWindow();return String(current(key))===String(next);},"Native export control readback mismatch: "+key);changed();}
    function toggle(key,next){ready();var c=control(ids[key]);if(value(c,"AXValue")!==next)press(c);readback(key,next);}
    function choose(key,next){
      ready();var c=control(ids[key]);if(String(value(c,"AXValue"))===next)return;press(c);
      var menus=choiceMenus();
      if(menus.length!==1)throw Error("Native export choice menu is ambiguous");
      var matches=children(menus[0]).filter(function(i){return value(i,"AXRole")==="AXMenuItem"&&String(value(i,"AXTitle")).replace(/^✔\s*/,"")===next;});
      if(matches.length!==1)throw Error("Native export choice is unavailable: "+next);sameWindow();press(matches[0]);
      readback(key,next);
    }
    // Render coordinates take an accessibility value or increments; typing is the fallback.
    function stepped(key,n){
      for(var i=0;i<256;i++){
        var before=Number(current(key));if(before===n)return true;if(!Number.isFinite(before))return false;
        if($.AXUIElementPerformAction(control(ids[key]),$(before<n?"AXIncrement":"AXDecrement"))!==0)return false;
        if(!wait(function(){return Number(current(key))!==before;},null,20))return false;
      }
      return false;
    }
    function number(key,n){ready();var c=control(ids[key]);if(Number(value(c,"AXValue"))===n)return;
      var set=$.AXUIElementSetAttributeValue(c,$("AXValue"),$(n));
      if(set!==0)set=$.AXUIElementSetAttributeValue(c,$("AXValue"),$(String(n)));
      if(set===0&&wait(function(){return Number(current(key))===n;},null,20)){route("range","axValue");changed();return;}
      if(stepped(key,n)){route("range","axIncrement");changed();return;}
      changed();c=control(ids[key]);
      if($.AXUIElementSetAttributeValue(c,$("AXFocused"),$(true))!==0||value(c,"AXFocused")!==true)throw Error("Native render coordinate is not focused");
      sameWindow();keyed("range");events.keystroke(String(n));sameWindow();foreground();events.keyCode(36);readback(key,n);
    }
    try{
      var settings=input.settings;
      toggle("pcm","On");toggle("mp3","Off");toggle("analysis","Off");toggle("mono","Off");toggle("normalize","Off");toggle("loop","Off");toggle("video","Off");
      if(settings.renderTarget){
        ready();selectRenderedTrack(settings.renderTarget,false);changed();
        toggle("returns",settings.includeReturnMainEffects===true?"On":"Off");
      }else{
        toggle("returns","Off");choose("track","Main");
      }
      choose("type","WAV");choose("rate",String(settings.sampleRate));choose("bits",String(settings.bitDepth));
      if(value(control(ids.dither),"AXEnabled")===true)choose("dither","No Dither");else if(settings.bitDepth!==32)throw Error("Native dither state is unavailable");
      settings.start.forEach(function(n,i){number("start"+i,n);});settings.length.forEach(function(n,i){number("length"+i,n);});
      settings.start.forEach(function(n,i){if(Number(owned["start"+i].value)!==n)throw Error("Native render start changed");});
      settings.length.forEach(function(n,i){if(Number(owned["length"+i].value)!==n)throw Error("Native render length changed");});
      var prepared={prepared:true,windowId:input.windowId,panelState:owned,exportPress:exportPress};
      if(settings.renderTarget)prepared.renderTarget=settings.renderTarget;
      return JSON.stringify(prepared);
    }catch(error){return JSON.stringify({prepared:false,error:String(error.message||error),windowId:input.windowId,panelState:owned,exportPress:exportPress});}
  }
  if(input.action==="cancel"){
    // After a sent Export press this call opened the only Save panel; cancel it before Export Audio/Video.
    var late=nativeDialogs().filter(function(entry){return entry.info.identity==="exportSavePanel";});
    if(input.exportPressed===true&&late.length===1)cancelDialog(late[0]);
    if(!exportOpen())reshownExport();
  }
  if(input.action==="cancel"&&!exportOpen()){
    var onscreen=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0)));
    var remaining=allWindows();
    if(!documentWindow(remaining)||remaining.some(function(w){return value(w,"AXSubrole")==="AXDialog"||value(w,"AXModal")===true||items(read(w,"AXSheets")).length>0;})||openSavePanels().panels.length||onscreen.some(function(w){return w.kCGWindowOwnerPID===input.pid&&w.kCGWindowNumber===input.windowId;}))throw Error("Export dialog closure is unverified");
    return JSON.stringify({cancelled:true,alreadyClosed:true});
  }
  window=namedWindow("Export Audio/Video");cache();
  if(input.action==="cancel"){
    if(windowId(window)!==input.windowId)throw Error("Native Export window changed; no Cancel was pressed");sameState(input.panelState);
    if(openSavePanels().panels.length||items(read(window,"AXSheets")).length)throw Error("Unexpected export sheet; no Cancel was pressed");
    press(control("Base.FinalButtonsBox.CancelButton"));wait(function(){return !exportOpen();},"Export dialog closure is unverified");return JSON.stringify({cancelled:true});
  }
  if(input.action!=="commit")throw Error("Unknown native audio export action");
  sameWindow();sameState(input.panelState);if(openSavePanels().panels.length||items(read(window,"AXSheets")).length)throw Error("Unexpected export sheet");
  if(input.renderTarget){
    try{selectRenderedTrack(input.renderTarget,true);sameState(input.panelState);}
    catch(error){return JSON.stringify({exportPressed:false,preserveDialog:true,error:String(error.message||error),exportPress:exportPress});}
  }
  var exportButton=control("Base.FinalButtonsBox.ExportButton");
  if(value(exportButton,"AXEnabled")!==true)throw Error("Native Export button is disabled");
  sameState(input.panelState);if(openSavePanels().panels.length)throw Error("Unexpected export sheet");
  if(windowId(window)!==input.windowId)throw Error("Native Export window changed");
  // AXPress enters Live's synchronous native Save panel, so its reply waits for that panel; a short timeout bounds the wait.
  var pressed=press(exportButton,0.5);exportPress.axResult=pressed;
  if(pressed===-25205||pressed===-25206){
    // The button refuses AXPress: activate the exact focused button through the keyboard.
    if($.AXUIElementSetAttributeValue(exportButton,$("AXFocused"),$(true))!==0||value(exportButton,"AXFocused")!==true)throw Error("Native Export button is not focused");
    try{keyed("export");}catch(error){return JSON.stringify({exportPressed:false,error:String(error.message||error),exportPress:exportPress});}
    events.keyCode(36);
  }else if(pressed!==0&&pressed!==-25204&&pressed!==-25200)return JSON.stringify({exportPressed:false,error:"Native Export press was refused ("+pressed+")",exportPress:exportPress});
  else route("export","axPress");
  exportPress.liveFrontmostAfterPress=process.frontmost();if(!exportPress.liveFrontmostAfterPress)exportPress.frontmostAfterPress=frontApp();
  function panelId(open){return open.source==="windows"?windowId(open.panels[0]):cgWindowId(value(open.panels[0],"AXTitle"));}
  // The press was sent: a Save panel that is late or unreadable is still reported as pressed, so cleanup owns it.
  try{
    var save=wait(function(){try{var open=openSavePanels();return open.panels.length===1&&Number.isInteger(panelId(open))&&open;}catch(error){return null;}},"Native audio Save panel did not appear",200,12);
    exportPress.savePanelSource=save.source;
    var result={exportPressed:true,saveWindowId:panelId(save),exportPress:exportPress};
  }catch(error){
    try{exportPress.afterWait={exportDialogListed:exportOpen(),dialogs:infos(nativeDialogs()),observed:observation()};}
    catch(readError){exportPress.afterWait={observationError:String(readError.message||readError)};}
    return JSON.stringify({exportPressed:true,error:String(error.message||error),exportPress:exportPress});
  }
  if(input.renderTarget){result.trackSelectionVerified=true;result.renderedTarget=input.renderTarget;}
  return JSON.stringify(result);
}
