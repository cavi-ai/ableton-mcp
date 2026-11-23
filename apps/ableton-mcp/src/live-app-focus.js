// Observe whether the exact running Live app already shows the requested window.
// Nothing is activated, and no Dock item is pressed.
function run(argv) {
  ObjC.import("AppKit");ObjC.import("ApplicationServices");ObjC.import("CoreGraphics");
  var input=JSON.parse(argv[0]),running=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
  if(!running||ObjC.unwrap(running.bundleIdentifier)!=="com.ableton.live"||ObjC.unwrap(running.bundleURL.path)!==input.appPath)throw Error("Expected the exact running Live app");
  function describe(app){if(!app)return null;return {pid:Number(ObjC.unwrap(app.processIdentifier)),name:ObjC.unwrap(app.localizedName)||null,bundleIdentifier:ObjC.unwrap(app.bundleIdentifier)||null};}
  function frontApp(){try{return describe($.NSWorkspace.sharedWorkspace.frontmostApplication);}catch(error){return null;}}
  var front=frontApp();
  if(input.action==="restore"){
    return JSON.stringify({restored:!!(front&&Number.isInteger(input.restorePid)&&front.pid===input.restorePid),activations:0,dockPressed:false,frontmost:front});
  }
  var listed=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0)));
  var onScreen=listed.some(function(window){
    return window.kCGWindowOwnerPID===input.pid&&(!input.windowId||window.kCGWindowNumber===input.windowId)&&window.kCGWindowIsOnscreen!==false;
  });
  var observed={focused:onScreen,activations:0,dockPressed:false,previous:front};
  if(!onScreen)observed.frontmost=front;
  return JSON.stringify(observed);
}
