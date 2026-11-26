// Bring the exact running Live app to the front of the current desktop. Inputs are data, never script source.
function run(argv) {
  ObjC.import("AppKit");ObjC.import("CoreGraphics");
  var input = JSON.parse(argv[0]);
  var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
  if (!running || ObjC.unwrap(running.bundleIdentifier) !== "com.ableton.live" || ObjC.unwrap(running.bundleURL.path) !== input.appPath)
    throw Error("Expected the exact running Live app");
  function describe(app) {
    if (!app) return null;
    return { pid: Number(ObjC.unwrap(app.processIdentifier)), name: ObjC.unwrap(app.localizedName) || null, bundleIdentifier: ObjC.unwrap(app.bundleIdentifier) || null };
  }
  function front() { try { return describe($.NSWorkspace.sharedWorkspace.frontmostApplication); } catch (error) { return null; } }
  function shown() {
    return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))).filter(function (window) {
      return window.kCGWindowOwnerPID === input.pid && window.kCGWindowLayer === 0 && window.kCGWindowIsOnscreen !== false;
    }).map(function (window) { return window.kCGWindowNumber; });
  }
  function state() {
    var app = front(), windows = shown();
    return { raised: !!(app && app.pid === input.pid && windows.length), frontmost: app, windowIds: windows };
  }
  var observed = state(), previous = observed.frontmost, activations = 0;
  // An Apple Event activate switches to Live's Space; `open -a` does not while a full-screen app is in front.
  if (input.action !== "observe") {
    for (var attempt = 0; attempt < 2 && !observed.raised; attempt++) {
      Application(input.appPath).activate();activations++;
      for (var i = 0; i < 60 && !observed.raised; i++) { delay(0.05);observed = state(); }
    }
  }
  return JSON.stringify({ raised: observed.raised, activations: activations, previous: previous, frontmost: observed.frontmost, windowIds: observed.windowIds });
}
