// Read or answer Live's startup crash-recovery prompt. Inputs are data, never script source.
function run(argv) {
  ObjC.import("AppKit");ObjC.import("ApplicationServices");
  var input = JSON.parse(argv[0]), retained = [];
  var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
  if (!running || ObjC.unwrap(running.bundleIdentifier) !== "com.ableton.live" || ObjC.unwrap(running.bundleURL.path) !== input.appPath)
    throw Error("Expected the exact running Live app");
  var root = $.AXUIElementCreateApplication(input.pid);
  // Live's main thread may stay busy while a Set loads after the prompt closes.
  $.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(), 1);
  function read(element, key) {
    var ref = Ref(), error = $.AXUIElementCopyAttributeValue(element, $(key), ref);
    if (error === -25212 || error === -25205) return null;
    if (error) throw Error("Live accessibility read failed: " + key + " (" + error + ")");
    var value = ObjC.castRefToObject(ref[0]);retained.push(value);return value;
  }
  function items(value) {
    var result = [];
    if (value) for (var i = 0; i < value.count; i++) result.push(value.objectAtIndex(i));
    return result;
  }
  var pattern = /^Live unexpectedly quit while you were working on the Live Set "(.*)\." Would you like to recover your work\?$/;
  // The prompt is Live's focused dialog; Live does not list it among its AXWindows.
  function prompt() {
    var dialog = read(root, "AXFocusedWindow");
    if (!dialog || ObjC.unwrap(read(dialog, "AXSubrole")) !== "AXDialog") return null;
    var texts = [], buttons = {};
    (function walk(element, depth) {
      items(read(element, "AXChildren")).forEach(function (child) {
        var role = ObjC.unwrap(read(child, "AXRole"));
        // Live adds an empty text element beside the message group.
        if (role === "AXStaticText") { var text = ObjC.unwrap(read(child, "AXValue")); if (text !== "") texts.push(text); }
        else if (role === "AXButton") {
          var name = String(ObjC.unwrap(read(child, "AXDescription")));
          buttons[name] = (buttons[name] || []).concat([child]);
        } else if (depth < 3) walk(child, depth + 1);
      });
    })(dialog, 0);
    var match = texts.length === 1 && typeof texts[0] === "string" ? texts[0].match(pattern) : null;
    if (!match || Object.keys(buttons).sort().join() !== "No,Yes" || buttons.No.length !== 1 || buttons.Yes.length !== 1) return null;
    return { message: texts[0], setName: match[1], buttons: buttons };
  }
  var current = prompt();
  if (input.answer === undefined) return JSON.stringify({ prompt: current && { message: current.message, setName: current.setName } });
  if (input.answer !== "No" && input.answer !== "Yes") throw Error("Answer must be No or Yes; no button was pressed");
  if (!current || current.message !== input.message) throw Error("Live is not showing the planned recovery prompt; no button was pressed");
  var button = current.buttons[input.answer][0];
  if (ObjC.unwrap(read(button, "AXEnabled")) !== true) throw Error("Live's " + input.answer + " button is disabled; no button was pressed");
  // A busy Live can time out the press reply after acting on it; only closure is evidence.
  $.AXUIElementPerformAction(button, $("AXPress"));
  var lastError = null;
  for (var deadline = Date.now() + 10000; Date.now() < deadline; delay(0.05)) {
    try { if (!prompt()) return JSON.stringify({ answered: input.answer, dismissed: true }); lastError = null; }
    catch (error) { lastError = error.message; }
  }
  var outcome = { answered: input.answer, dismissed: false };
  if (lastError) outcome.observationError = lastError;
  return JSON.stringify(outcome);
}
