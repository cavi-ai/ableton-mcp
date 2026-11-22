// Bring the exact running Live app to the front before native input, or give focus back to the app
// that was frontmost before (action "restore"). Activation is retried a bounded number of times.
function run(argv) {
  ObjC.import("AppKit");ObjC.import("ApplicationServices");ObjC.import("CoreGraphics");
  var input=JSON.parse(argv[0]),running=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid),retained=[];
  if(!running||ObjC.unwrap(running.bundleIdentifier)!=="com.ableton.live"||ObjC.unwrap(running.bundleURL.path)!==input.appPath)throw Error("Expected the exact running Live app");
  var appRoot=$.AXUIElementCreateApplication(input.pid),attempts=Number.isInteger(input.attempts)&&input.attempts>0&&input.attempts<=10?input.attempts:3;
  function read(element,key){var ref=Ref(),error=$.AXUIElementCopyAttributeValue(element,$(key),ref);if(error===-25212||error===-25205)return null;if(error)throw Error("Dock accessibility is unavailable");var value=ObjC.castRefToObject(ref[0]);retained.push(value);return value;}
  function items(value){var result=[];if(value)for(var i=0;i<value.count;i++)result.push(value.objectAtIndex(i));return result;}
  function describe(app){if(!app)return null;return {pid:Number(ObjC.unwrap(app.processIdentifier)),name:ObjC.unwrap(app.localizedName)||null,bundleIdentifier:ObjC.unwrap(app.bundleIdentifier)||null};}
  function frontApp(){try{return describe($.NSWorkspace.sharedWorkspace.frontmostApplication);}catch(error){return null;}}
  // AppKit activation properties may remain cached until its run loop advances; accessibility reads current focus.
  function isFront(pid){try{return ObjC.unwrap(read($.AXUIElementCreateApplication(pid),"AXFrontmost"))===true;}catch(error){return false;}}
  function settle(check){for(var i=0;i<20;i++){if(check())return true;delay(0.05);}return false;}
  if(input.action==="restore"){
    var target=Number.isInteger(input.restorePid)&&input.restorePid!==input.pid?$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.restorePid):null;
    if(!target)throw Error("The app to give focus back to is not running");
    var back=function(){return isFront(input.restorePid);};
    if(back())return JSON.stringify({restored:true,activations:0,frontmost:describe(target)});
    for(var r=1;r<=attempts;r++){target.activateWithOptions(3);if(settle(back))return JSON.stringify({restored:true,activations:r,frontmost:describe(target)});}
    return JSON.stringify({restored:false,activations:attempts,frontmost:frontApp()});
  }
  var previous=frontApp();
  function visible(){
    return isFront(input.pid)&&ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))).some(function(w){return w.kCGWindowOwnerPID===input.pid&&(!input.windowId||w.kCGWindowNumber===input.windowId);});
  }
  for(var attempt=1;attempt<=attempts;attempt++){
    running.activateWithOptions(3);
    if(settle(visible))return JSON.stringify({focused:true,activations:attempt,previous:previous});
  }
  // Activation can leave Live's windows behind; its Dock item, selected by file URL rather than label, shows them.
  var docks=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.dock");
  if(Number(docks.count)!==1)throw Error("Live desktop activation is unavailable");
  var root=$.AXUIElementCreateApplication(docks.objectAtIndex(0).processIdentifier),matches=[];
  items(read(root,"AXChildren")).forEach(function(list){items(read(list,"AXChildren")).forEach(function(item){
    if(ObjC.unwrap(read(item,"AXSubrole"))!=="AXApplicationDockItem")return;
    var url=read(item,"AXURL");if(url&&ObjC.unwrap(url.path)===input.appPath)matches.push(item);
  });});
  if(matches.length!==1)throw Error("The exact Live Dock item is unavailable or ambiguous");
  $.AXUIElementPerformAction(matches[0],$("AXPress"));
  if(settle(visible)||settle(visible))return JSON.stringify({focused:true,activations:attempts,dockPressed:true,previous:previous});
  return JSON.stringify({focused:false,activations:attempts,dockPressed:true,previous:previous,frontmost:frontApp(),
    error:"Live did not come to the front; no native input was sent"});
}
