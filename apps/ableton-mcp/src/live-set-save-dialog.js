// Runs in JavaScript for Automation, through osascript. Inputs are data, never script source.
function run(argv) {
  ObjC.import("CoreGraphics");
  ObjC.import("ApplicationServices");
  ObjC.import("Foundation");
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
  function waitFor(read, message, background) {
    for (var i = 0; i < 40; i++) {
      if (!background) foreground();
      var result = read();
      if (result) return result;
      delay(0.05);
    }
    throw Error(message);
  }
  function panel(background) {
    if (!background) foreground();
    var matches = process.windows().filter(function (window) { return attribute(window, "AXIdentifier") === "save-panel"; });
    if (matches.length !== 1 || attribute(matches[0], "AXModal") !== true)
      throw Error("Expected one native Save panel");
    return matches[0];
  }
  function windowIdentity(window, background) {
    var position = window.position(), size = window.size();
    var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
    var matches = windows.filter(function (item) {
      var bounds = item.kCGWindowBounds;
      return item.kCGWindowOwnerPID === input.pid &&
        bounds.X === position[0] && bounds.Y === position[1] && bounds.Width === size[0] && bounds.Height === size[1];
    });
    var onscreen = matches.filter(function (item) { return item.kCGWindowIsOnscreen === true; });
    if (onscreen.length) matches = onscreen;
    else if (!background) throw Error("Native Save window is not onscreen");
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
  function directoryPath() {
    // System Events omits AXColumns and AXSelectedChildren values. Read the
    // native browser directly; its parent column identifies the open directory
    // even when that directory is empty. Displayed folder names are ambiguous.
    var retained = [];
    function read(element, key) {
      var value = Ref(), error = $.AXUIElementCopyAttributeValue(element, $(key), value);
      if (error === -25212 || error === -25205) return null; // No value or unsupported attribute
      if (error) throw Error("Save directory attribute is unavailable: " + key);
      var result = ObjC.castRefToObject(value[0]);retained.push(result);return result;
    }
    function items(value) {
      var result = [];
      if (value) for (var i = 0; i < value.count; i++) result.push(value.objectAtIndex(i));
      return result;
    }
    function text(element, key) { return ObjC.unwrap(read(element, key)); }
    function browser(element, depth) {
      if (depth > 5) return [];
      if (text(element, "AXIdentifier") === "ColumnView" && text(element, "AXRole") === "AXBrowser") return [element];
      if (["AXScrollArea", "AXOutline", "AXTable", "AXBrowser"].indexOf(text(element, "AXRole")) !== -1) return [];
      return items(read(element, "AXChildren")).reduce(function (out, child) { return out.concat(browser(child, depth + 1)); }, []);
    }
    var windows = items(read($.AXUIElementCreateApplication(input.pid), "AXWindows")).filter(function (window) {
      return text(window, "AXIdentifier") === "save-panel";
    });
    if (windows.length !== 1) throw Error("Save directory window is unavailable");
    var browsers = browser(windows[0], 0);
    if (browsers.length !== 1) throw Error("Save directory requires the native column view");
    var columns = items(read(browsers[0], "AXColumns"));
    if (columns.length < 2) throw Error("Save directory parent column is unavailable");
    var lists = items(read(columns[columns.length - 2], "AXChildren")).filter(function (child) { return text(child, "AXRole") === "AXList"; });
    if (lists.length !== 1) throw Error("Save directory selection is unavailable");
    var rows = items(read(lists[0], "AXSelectedChildren"));
    if (rows.length !== 1) throw Error("Save directory selection is ambiguous");
    var urls = items(read(rows[0], "AXChildren")).map(function (child) { return read(child, "AXURL"); }).filter(Boolean);
    if (urls.length !== 1 || !ObjC.unwrap(urls[0].isFileURL) || !ObjC.unwrap(urls[0].hasDirectoryPath))
      throw Error("Save directory file URL is unavailable");
    var path = ObjC.unwrap(urls[0].filePathURL.path);
    if (typeof path !== "string" || path.charAt(0) !== "/") throw Error("Save directory path is unavailable");
    return path;
  }
  function panelState(window) {
    return { name: find(window, "saveAsNameTextField", "AXTextField").value(),
      folder: directoryPath() };
  }
  function sameState(window, expected) {
    var current = panelState(window);
    if (!expected || typeof expected.name !== "string" || typeof expected.folder !== "string" ||
        current.name !== expected.name || current.folder !== expected.folder)
      throw Error("Save panel input changed; preserve current input");
  }
  function cancelPrepared(expected, ownedFolderPath) {
    var save = panel(true);
    if (windowIdentity(save, true) !== input.windowId || purpose(save) !== input.purpose)
      throw Error("Prepared Save As window changed; no Cancel was pressed");
    sameState(save, expected);
    var sheets = save.sheets();
    if (sheets.length) {
      if (sheets.length !== 1 || attribute(sheets[0], "AXIdentifier") !== "GoToWindow" ||
          typeof ownedFolderPath !== "string" || find(sheets[0], "PathTextField", "AXTextField").value() !== ownedFolderPath)
        throw Error("Save sheet is not owned by this operation; no Cancel was pressed");
      find(sheets[0], "CloseButton", "AXButton").actions.byName("AXPress").perform();
      waitFor(function () { return save.sheets().length === 0; }, "Folder sheet closure is unverified", true);
    }
    noSheet(save);sameState(save, expected);
    if (windowIdentity(save, true) !== input.windowId || purpose(save) !== input.purpose)
      throw Error("Prepared Save As window changed; no Cancel was pressed");
    var button = find(save, "CancelButton", "AXButton");
    if (!button.enabled()) throw Error("Cancel is disabled");
    button.actions.byName("AXPress").perform();
    waitFor(function () {
      if (process.windows().some(function (window) { return attribute(window, "AXIdentifier") === "save-panel"; })) return false;
      // AppKit can retain a closed, offscreen native window in the all-windows
      // list. Require accessibility removal and absence from onscreen windows.
      var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)));
      return !windows.some(function (window) {
        return window.kCGWindowOwnerPID === input.pid && window.kCGWindowNumber === input.windowId;
      });
    }, "Prepared Save panel closure is unverified", true);
    return { cancelled: true, savePressed: false, windowId: input.windowId };
  }
  if (input.action === "cancel") return JSON.stringify(cancelPrepared(input.panelState));
  if (input.action === "prepare") {
    foreground();
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
    return JSON.stringify({ prepared: true, windowId: windowId, purpose: purpose(save), panelState: panelState(save) });
  }
  if (input.action !== "commit") throw Error("Unknown Save As action");
  var ownedState = input.panelState, ownedFolderPath = null, saveAttempted = false;
  try {
    var save = panel();noSheet(save);sameState(save, ownedState);
    if (windowIdentity(save) !== input.windowId || purpose(save) !== input.purpose)
      throw Error("Prepared Save As window changed; no Save was pressed");
    focusPanel(save);
    // Resolve the destination in the same process that presses Save. A user-selected
    // folder between preparation and confirmation cannot redirect this operation.
    events.keystroke("g", { using: ["command down", "shift down"] });
    var sheet = waitFor(function () { return save.sheets().length === 1 && save.sheets()[0]; }, "Go to Folder did not appear");
    if (attribute(sheet, "AXIdentifier") !== "GoToWindow") throw Error("Unexpected folder sheet");
    var path = find(sheet, "PathTextField", "AXTextField");
    ownedFolderPath = path.value();
    path.value = input.parent;
    ownedFolderPath = input.parent;
    path.attributes.byName("AXFocused").value = true;
    if (path.value() !== input.parent || attribute(path, "AXFocused") !== true) throw Error("Folder field is not focused on the requested path");
    foreground();events.keyCode(36);
    waitFor(function () { return save.sheets().length === 0; }, "Folder navigation is unverified");
    if (directoryPath() !== input.parent)
      throw Error("Destination folder readback mismatch");
    ownedFolderPath = null;ownedState = panelState(save);
    var name = find(save, "saveAsNameTextField", "AXTextField");
    name.value = input.name;
    if (name.value() !== input.name) throw Error("Save filename readback mismatch");
    ownedState = panelState(save);
    noSheet(save);
    var button = find(save, "OKButton", "AXButton");
    if (!button.enabled()) throw Error("Save is disabled");
    if (windowIdentity(save) !== input.windowId || purpose(save) !== input.purpose)
      throw Error("Prepared Save As window changed; no Save was pressed");
    focusPanel(save);saveAttempted = true;button.actions.byName("AXPress").perform();
    return JSON.stringify({ savePressed: true });
  } catch (error) {
    var recovery = { status: "unavailable", reason: "Save button outcome is unknown; inspect Live and the destination" };
    if (!saveAttempted) {
      try {
        var cancelled = cancelPrepared(ownedState, ownedFolderPath);
        recovery = { status: "cancelled", windowId: cancelled.windowId, savePressed: false };
      } catch (cleanupError) { recovery = { status: "unavailable", reason: String(cleanupError.message || cleanupError).slice(0,600) }; }
    }
    return JSON.stringify({ error: String(error.message || error).slice(0,600), savePressed: saveAttempted ? null : false,
      recovery: recovery });
  }
}
