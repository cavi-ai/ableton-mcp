// Runs in JavaScript for Automation, through osascript. Inputs are data, never script source.
function run(argv) {
  ObjC.import("CoreGraphics");
  var input = JSON.parse(argv[0]), events = Application("System Events");
  var processes = events.applicationProcesses.whose({ unixId: input.pid })();
  if (processes.length !== 1 || processes[0].bundleIdentifier() !== "com.ableton.live")
    throw Error("Expected the exact Live process");
  var process = processes[0];
  function attribute(element, key) {
    try { return element.attributes.byName(key).value(); } catch (error) { return null; }
  }
  function foreground() {
    if (!process.frontmost()) throw Error("Live is not frontmost; no key was sent");
  }
  function waitFor(read, message) {
    for (var i = 0; i < 40; i++) {
      foreground();
      var result = read();
      if (result) return result;
      delay(0.05);
    }
    throw Error(message);
  }
  function panel() {
    foreground();
    var matches = process.windows().filter(function (window) { return attribute(window, "AXIdentifier") === "save-panel"; });
    if (matches.length !== 1 || attribute(matches[0], "AXModal") !== true)
      throw Error("Expected one native Save panel");
    return matches[0];
  }
  function windowIdentity(window) {
    var position = window.position(), size = window.size();
    var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)));
    var matches = windows.filter(function (item) {
      var bounds = item.kCGWindowBounds;
      return item.kCGWindowOwnerPID === input.pid &&
        bounds.X === position[0] && bounds.Y === position[1] && bounds.Width === size[0] && bounds.Height === size[1];
    });
    if (matches.length !== 1) throw Error("Native Save window identity is unavailable or ambiguous");
    return matches[0].kCGWindowNumber;
  }
  function purpose(window) {
    var text = find(window, "_messageTextField", "AXStaticText").value();
    if (text !== "Save Live Set As:") throw Error("Expected Live Set Save As, not another Save dialog");
    return text;
  }
  function focusPanel(window) {
    window.attributes.byName("AXMain").value = true;
    if (attribute(window, "AXMain") !== true) throw Error("Save panel is not the main window");
    foreground();
  }
  function find(root, identifier, expectedRole) {
    var matches = [];
    function walk(element, depth) {
      if (depth > 5) return;
      var role = element.role();
      if (attribute(element, "AXIdentifier") === identifier && role === expectedRole) matches.push(element);
      if (["AXScrollArea", "AXOutline", "AXTable", "AXBrowser"].indexOf(role) !== -1) return;
      element.uiElements().forEach(function (child) { walk(child, depth + 1); });
    }
    walk(root, 0);
    if (matches.length !== 1) throw Error("Expected one Save control: " + identifier);
    return matches[0];
  }
  function noSheet(window) {
    if (window.sheets().length) throw Error("Unexpected sheet; no Save was pressed");
  }
  foreground();
  if (input.action === "prepare") {
    if (process.windows().some(function (window) {
      return attribute(window, "AXModal") === true || window.sheets().length > 0;
    })) throw Error("Dismiss the existing Live dialog before Save As");
    var menu = process.menuBars()[0].menuBarItems.byName("File").menus()[0].menuItems.byName("Save Live Set As...");
    if (!menu.exists() || !menu.enabled()) throw Error("Live Set Save As menu is unavailable (requires English Live)");
    menu.actions.byName("AXPress").perform();
    var save = waitFor(function () {
      return process.windows().some(function (window) { return attribute(window, "AXIdentifier") === "save-panel"; });
    }, "Save As panel did not appear");
    save = panel();focusPanel(save);
    var windowId = waitFor(function () {
      try { return windowIdentity(save); } catch (error) { return null; }
    }, "Native Save window identity is unavailable or ambiguous");
    return JSON.stringify({ prepared: true, windowId: windowId, purpose: purpose(save) });
  }
  if (input.action !== "commit") throw Error("Unknown Save As action");
  var save = panel();noSheet(save);
  if (windowIdentity(save) !== input.windowId || purpose(save) !== input.purpose)
    throw Error("Prepared Save As window changed; no Save was pressed");
  focusPanel(save);
  // Resolve the destination in the same process that presses Save. A user-selected
  // folder between preparation and confirmation cannot redirect this operation.
  events.keystroke("g", { using: ["command down", "shift down"] });
  var sheet = waitFor(function () { return save.sheets().length === 1 && save.sheets()[0]; }, "Go to Folder did not appear");
  if (attribute(sheet, "AXIdentifier") !== "GoToWindow") throw Error("Unexpected folder sheet");
  var path = find(sheet, "PathTextField", "AXTextField");
  path.value = input.parent;
  path.attributes.byName("AXFocused").value = true;
  if (path.value() !== input.parent || attribute(path, "AXFocused") !== true) throw Error("Folder field is not focused on the requested path");
  foreground();events.keyCode(36);
  waitFor(function () { return save.sheets().length === 0; }, "Folder navigation is unverified");
  if (find(save, "where popup", "AXPopUpButton").value() !== input.parent.split("/").pop())
    throw Error("Destination folder readback mismatch");
  var name = find(save, "saveAsNameTextField", "AXTextField");
  name.value = input.name;
  if (name.value() !== input.name) throw Error("Save filename readback mismatch");
  noSheet(save);
  var button = find(save, "OKButton", "AXButton");
  if (!button.enabled()) throw Error("Save is disabled");
  if (windowIdentity(save) !== input.windowId || purpose(save) !== input.purpose)
    throw Error("Prepared Save As window changed; no Save was pressed");
  focusPanel(save);button.actions.byName("AXPress").perform();
  return JSON.stringify({ savePressed: true });
}
