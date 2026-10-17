// Bring the exact running Live app onto a visible desktop before native input.
function run(argv) {
  ObjC.import("AppKit");ObjC.import("ApplicationServices");ObjC.import("CoreGraphics");
  var input=JSON.parse(argv[0]),running=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid),retained=[];
  if(!running||ObjC.unwrap(running.bundleIdentifier)!=="com.ableton.live"||ObjC.unwrap(running.bundleURL.path)!==input.appPath)throw Error("Expected the exact running Live app");
  var appRoot=$.AXUIElementCreateApplication(input.pid);
  function visible(){
    // AppKit activation properties may remain cached until its run loop advances.
    return ObjC.unwrap(read(appRoot,"AXFrontmost"))===true&&ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))).some(function(w){return w.kCGWindowOwnerPID===input.pid&&(!input.windowId||w.kCGWindowNumber===input.windowId);});
  }
  function wait(){for(var i=0;i<40;i++){if(visible())return true;delay(0.05);}return false;}
  running.activateWithOptions(3);
  if(visible())return JSON.stringify({focused:true});
  // Activation alone may leave modal windows on another macOS Space. The Dock
  // switches to the app's desktop; select its file URL rather than its label.
  function read(element,key){var ref=Ref(),error=$.AXUIElementCopyAttributeValue(element,$(key),ref);if(error===-25212||error===-25205)return null;if(error)throw Error("Dock accessibility is unavailable");var value=ObjC.castRefToObject(ref[0]);retained.push(value);return value;}
  function items(value){var result=[];if(value)for(var i=0;i<value.count;i++)result.push(value.objectAtIndex(i));return result;}
  var docks=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.dock");
  if(Number(docks.count)!==1)throw Error("Live desktop activation is unavailable");
  var root=$.AXUIElementCreateApplication(docks.objectAtIndex(0).processIdentifier),matches=[];
  items(read(root,"AXChildren")).forEach(function(list){items(read(list,"AXChildren")).forEach(function(item){
    if(ObjC.unwrap(read(item,"AXSubrole"))!=="AXApplicationDockItem")return;
    var url=read(item,"AXURL");if(url&&ObjC.unwrap(url.path)===input.appPath)matches.push(item);
  });});
  if(matches.length!==1)throw Error("The exact Live Dock item is unavailable or ambiguous");
  $.AXUIElementPerformAction(matches[0],$("AXPress"));
  if(!wait())throw Error("Live did not become visible; no native input was sent");
  return JSON.stringify({focused:true});
}
