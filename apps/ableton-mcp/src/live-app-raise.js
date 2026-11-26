// Bring the exact running Live app to the front of the current desktop. Inputs are data, never script source.
function run(argv) {
  ObjC.import("AppKit");ObjC.import("CoreGraphics");
  var input = JSON.parse(argv[0]);
  function requireLive() {
    var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
    if (running.isNil() || running.isTerminated || ObjC.unwrap(running.bundleIdentifier) !== "com.ableton.live" ||
        ObjC.unwrap(running.bundleURL.path) !== input.appPath)
      throw Error("Expected the exact running Live app");
  }
  requireLive();
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
  // Address the activate Apple Event to the confirmed PID. This keeps the Space switch
  // without resolving the bundle again or launching Live if that process exits.
  if (input.action !== "observe") {
    var target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(input.pid);
    for (var attempt = 0; attempt < 2 && !observed.raised; attempt++) {
      requireLive();
      var event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
        0x6d697363, 0x61637476, target, -1, 0); // 'misc' / 'actv'
      var failure = Ref();
      var reply = event.sendEventWithOptionsTimeoutError($.NSAppleEventSendDefaultOptions, 3, failure);
      if (reply.isNil()) {
        var reason = failure[0] && ObjC.unwrap(failure[0].localizedDescription);
        throw Error("Live activation event failed" + (reason ? ": " + reason : ""));
      }
      var errorCode = reply.paramDescriptorForKeyword(0x6572726e).int32Value; // 'errn'
      if (errorCode) throw Error("Live refused the activation event (" + errorCode + ")");
      activations++;
      for (var i = 0; i < 60 && !observed.raised; i++) { delay(0.05);observed = state(); }
    }
  }
  return JSON.stringify({ raised: observed.raised, activations: activations, previous: previous, frontmost: observed.frontmost, windowIds: observed.windowIds });
}
