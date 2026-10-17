// JavaScript for Automation. Retained native AX elements survive chooser-window insertions.
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
  function foreground(){if(!process.frontmost())throw Error("Live is not foreground; no key was sent");}
  function wait(read,message){for(var i=0;i<40;i++){var result=read();if(result)return result;delay(0.05);}throw Error(message);}
  function namedWindow(title){var matches=windows().filter(function(w){return value(w,"AXTitle")===title;});if(matches.length!==1)throw Error("Expected one native "+title+" window");return matches[0];}
  function windowId(w){
    var title=value(w,"AXTitle"),same=windows().filter(function(current){return value(current,"AXTitle")===title;});
    if(same.length!==1||!$.CFEqual(same[0],w))throw Error("Native window changed");
    var list=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))).filter(function(item){return item.kCGWindowOwnerPID===input.pid&&item.kCGWindowName===title;});
    if(list.length!==1)throw Error("Native window identity is unavailable or ambiguous");return list[0].kCGWindowNumber;
  }
  function savePanels(){return windows().filter(function(w){return value(w,"AXIdentifier")==="save-panel";});}
  function press(e){if(value(e,"AXEnabled")!==true)throw Error("Native control is disabled");return $.AXUIElementPerformAction(e,$("AXPress"));}
  if(input.action==="status"){
    var all=windows(),blocked=all.some(function(w){return value(w,"AXSubrole")==="AXDialog"||value(w,"AXModal")===true||items(read(w,"AXSheets")).length>0;});
    return JSON.stringify({uiComplete:!blocked&&all.some(function(w){return value(w,"AXSubrole")==="AXStandardWindow"&&typeof value(w,"AXDocument")==="string";})});
  }
  if(input.action==="commit"){
    $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid).activateWithOptions(3);
    wait(function(){if(!process.frontmost())return false;try{return windowId(namedWindow("Export Audio/Video"))===input.windowId;}catch(error){return false;}},"Prepared Export window did not become visible");
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
  function sameWindow(){foreground();if(windowId(window)!==input.windowId)throw Error("Native Export window changed");}
  var owned=null;
  if(input.action==="prepare"){
    $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid).activateWithOptions(3);
    wait(function(){return process.frontmost();},"Live did not become foreground; no key was sent");
    if(windows().some(function(w){return value(w,"AXSubrole")==="AXDialog"||value(w,"AXModal")===true||items(read(w,"AXSheets")).length>0;}))throw Error("Resolve the existing Live dialog before audio export");
    events.keystroke("r",{using:["command down","shift down"]});
    window=wait(function(){try{return namedWindow("Export Audio/Video");}catch(error){return null;}},"Native Export dialog did not appear");
    input.windowId=wait(function(){try{return windowId(window);}catch(error){return null;}},"Native Export window did not become visible");cache();owned=state();
    function ready(){sameWindow();sameState(owned);}
    function changed(){cache();owned=state();}
    function readback(key,next){wait(function(){sameWindow();cache();return String(value(control(ids[key]),"AXValue"))===String(next);},"Native export control readback mismatch: "+key);changed();}
    function toggle(key,next){ready();var c=control(ids[key]);if(value(c,"AXValue")!==next)press(c);readback(key,next);}
    function choose(key,next){
      ready();var c=control(ids[key]);if(String(value(c,"AXValue"))===next)return;press(c);
      var menus=[];windows().filter(function(w){return value(w,"AXSubrole")==="AXUnknown";}).forEach(function(w){function walk(e,d){if(d>3)return;if(value(e,"AXIdentifier")==="ChooserPopUp")menus.push(e);else children(e).forEach(function(c){walk(c,d+1);});}walk(w,0);});
      if(menus.length!==1)throw Error("Native export choice menu is ambiguous");
      var matches=children(menus[0]).filter(function(i){return value(i,"AXRole")==="AXMenuItem"&&String(value(i,"AXTitle")).replace(/^✔\s*/,"")===next;});
      if(matches.length!==1)throw Error("Native export choice is unavailable: "+next);sameWindow();press(matches[0]);
      readback(key,next);
    }
    function number(key,n){ready();var c=control(ids[key]);if(Number(value(c,"AXValue"))===n)return;
      if($.AXUIElementSetAttributeValue(c,$("AXFocused"),$(true))!==0||value(c,"AXFocused")!==true)throw Error("Native render coordinate is not focused");
      sameWindow();events.keystroke(String(n));sameWindow();events.keyCode(36);readback(key,n);
    }
    try{
      var settings=input.settings;
      toggle("pcm","On");toggle("mp3","Off");toggle("analysis","Off");toggle("mono","Off");toggle("normalize","Off");toggle("loop","Off");toggle("returns","Off");toggle("video","Off");
      choose("track","Main");choose("type","WAV");choose("rate",String(settings.sampleRate));choose("bits",String(settings.bitDepth));
      if(value(control(ids.dither),"AXEnabled")===true)choose("dither","No Dither");else if(settings.bitDepth!==32)throw Error("Native dither state is unavailable");
      settings.start.forEach(function(n,i){number("start"+i,n);});settings.length.forEach(function(n,i){number("length"+i,n);});
      settings.start.forEach(function(n,i){if(Number(owned["start"+i].value)!==n)throw Error("Native render start changed");});
      settings.length.forEach(function(n,i){if(Number(owned["length"+i].value)!==n)throw Error("Native render length changed");});
      return JSON.stringify({prepared:true,windowId:input.windowId,panelState:owned});
    }catch(error){return JSON.stringify({prepared:false,error:String(error.message||error),windowId:input.windowId,panelState:owned});}
  }
  if(input.action==="cancel"&&!windows().some(function(w){return value(w,"AXTitle")==="Export Audio/Video";})){
    var onscreen=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0)));
    var remaining=windows();
    if(!remaining.some(function(w){return value(w,"AXSubrole")==="AXStandardWindow"&&typeof value(w,"AXDocument")==="string";})||remaining.some(function(w){return value(w,"AXSubrole")==="AXDialog"||value(w,"AXModal")===true||items(read(w,"AXSheets")).length>0;})||savePanels().length||onscreen.some(function(w){return w.kCGWindowOwnerPID===input.pid&&w.kCGWindowNumber===input.windowId;}))throw Error("Export dialog closure is unverified");
    return JSON.stringify({cancelled:true,alreadyClosed:true});
  }
  window=namedWindow("Export Audio/Video");cache();
  if(input.action==="cancel"){
    if(windowId(window)!==input.windowId)throw Error("Native Export window changed; no Cancel was pressed");sameState(input.panelState);
    if(savePanels().length||items(read(window,"AXSheets")).length)throw Error("Unexpected export sheet; no Cancel was pressed");
    press(control("Base.FinalButtonsBox.CancelButton"));wait(function(){return !windows().some(function(w){return value(w,"AXTitle")==="Export Audio/Video";});},"Export dialog closure is unverified");return JSON.stringify({cancelled:true});
  }
  if(input.action!=="commit")throw Error("Unknown native audio export action");
  sameWindow();sameState(input.panelState);if(savePanels().length||items(read(window,"AXSheets")).length)throw Error("Unexpected export sheet");
  // AXPress enters Live's synchronous native Save panel and blocks subsequent
  // accessibility requests. Activate the exact focused button through the keyboard.
  var exportButton=control("Base.FinalButtonsBox.ExportButton");
  if(value(exportButton,"AXEnabled")!==true||$.AXUIElementSetAttributeValue(exportButton,$("AXFocused"),$(true))!==0||value(exportButton,"AXFocused")!==true)throw Error("Native Export button is not focused");
  sameWindow();sameState(input.panelState);events.keyCode(36);
  var save=wait(function(){var panels=savePanels();return panels.length===1&&panels[0];},"Native audio Save panel did not appear");
  return JSON.stringify({exportPressed:true,saveWindowId:windowId(save)});
}
