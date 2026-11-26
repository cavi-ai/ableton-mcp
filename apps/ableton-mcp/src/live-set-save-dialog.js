// Runs in JavaScript for Automation, through osascript. Inputs are data, never script source.
function run(argv) {
  ObjC.import("CoreGraphics");
  ObjC.import("ApplicationServices");
  ObjC.import("Foundation");
  ObjC.import("AppKit");
  var input = JSON.parse(argv[0]), events = Application("System Events");
  var processes = events.applicationProcesses.whose({ unixId: input.pid })();
  if (processes.length !== 1 || processes[0].bundleIdentifier() !== "com.ableton.live")
    throw Error("Expected the exact Live process");
  var process = processes[0];
  var expectedPurpose = input.action === "adoptMidiExport" || input.purpose === "Save MIDI Clip As:" ? "Save MIDI Clip As:"
    : input.action === "adoptAudioExport" || input.purpose === "Save Audio File As:" ? "Save Audio File As:" : "Save Live Set As:";
  var exporting = expectedPurpose !== "Save Live Set As:", retained = [];
  // The audio export Save panel is read and named through accessibility. The panel enables Save only while Live
  // is frontmost, so Save is pressed right after that is verified.
  var audio = expectedPurpose === "Save Audio File As:", exportPress = { steps: {}, keys: [], activations: 0 };
  function route(step, kind) {
    var current = exportPress.steps[step];
    if (!current) exportPress.steps[step] = kind;
    else if (current.split("+").indexOf(kind) === -1) exportPress.steps[step] = current + "+" + kind;
  }
  function nativeRead(element, key) {
    var ref = Ref(), error = $.AXUIElementCopyAttributeValue(element, $(key), ref);
    if (error === -25212 || error === -25205) return null;
    if (error) { var failure=Error("Native Save accessibility read failed: " + key + " (" + error + ")");failure.nativeAxCode=error;throw failure; }
    var value = ObjC.castRefToObject(ref[0]);retained.push(value);return value;
  }
  function nativeItems(value) {
    var result = [];
    if (value) for (var i = 0; i < value.count; i++) result.push(value.objectAtIndex(i));
    return result;
  }
  function nativeObservation(read) {
    for (var attempt=0; ; attempt++) {
      try { return read(); }
      catch (error) { if (error.nativeAxCode!==-25202 || attempt>=19) throw error;delay(0.05); }
    }
  }
  function nativeElement(element) {
    function get(key) { return ObjC.unwrap(nativeRead(element, key)); }
    function set(key, value) { if ($.AXUIElementSetAttributeValue(element, $(key), $(value)) !== 0) throw Error("Native Save input is not settable: " + key); }
    var wrapped = { native: element, name: function () { return get("AXTitle"); }, role: function () { return get("AXRole"); },
      uiElements: function () { return nativeItems(nativeRead(element, "AXChildren")).map(nativeElement); },
      sheets: function () { return nativeObservation(function () { return nativeItems(nativeRead(element, "AXChildren")).filter(function (child) { return ObjC.unwrap(nativeRead(child, "AXRole")) === "AXSheet"; }).map(nativeElement); }); },
      enabled: function () { return get("AXEnabled") === true; },
      attributes: { byName: function (key) { var attr = {};Object.defineProperty(attr, "value", { get: function () { return function () { return get(key); }; }, set: function (value) { set(key, value); } });return attr; } },
      actions: { byName: function (action) { return { perform: function () { if ($.AXUIElementPerformAction(element, $(action)) !== 0) throw Error("Native Save action outcome is unknown"); } }; } } };
    Object.defineProperty(wrapped, "value", { get: function () { return function () { return get("AXValue"); }; }, set: function (value) { set("AXValue", value); } });
    return wrapped;
  }
  function nativeWindows() {
    return nativeItems(nativeRead($.AXUIElementCreateApplication(input.pid), "AXWindows"));
  }
  // System Events and AXWindows can omit Live's dialog windows; its focused window stays readable.
  function focusedDialog() {
    var focused = nativeRead($.AXUIElementCreateApplication(input.pid), "AXFocusedWindow");
    return focused && (ObjC.unwrap(nativeRead(focused, "AXModal")) === true || ObjC.unwrap(nativeRead(focused, "AXSubrole")) === "AXDialog") ? focused : null;
  }
  function focusedSavePanel() {
    var focused = focusedDialog();
    return focused && ObjC.unwrap(nativeRead(focused, "AXIdentifier")) === "save-panel" ? nativeElement(focused) : null;
  }
  function listedSavePanels() {
    return nativeWindows().filter(function (window) { return ObjC.unwrap(nativeRead(window, "AXIdentifier")) === "save-panel"; });
  }
  // The Set Save panel is bound natively, so it stays readable while Live is behind other apps.
  function livePanel() {
    var listed = listedSavePanels(), focused = listed.length ? null : focusedSavePanel();
    if (focused) return focused;
    if (listed.length !== 1 || ObjC.unwrap(nativeRead(listed[0], "AXModal")) !== true) throw Error("Expected one native Save panel");
    return nativeElement(listed[0]);
  }
  function livePanelOpen() { return listedSavePanels().length > 0 || !!focusedSavePanel(); }
  function attribute(element, key) {
    try { return element.attributes.byName(key).value(); } catch (error) { return null; }
  }
  // This request set the audio filename itself, so its own audio panel is cancelled whatever name the panel now shows.
  function ownState(window, expected) {
    if (!audio) return sameState(window, expected);
    try { exportPress.cancelState = panelState(window); } catch (error) { exportPress.cancelState = { error: String(error.message || error).slice(0, 200) }; }
  }
  function waitFor(read, message, background, count) {
    for (var i = 0; i < (count || 40); i++) {
      var result = read();
      if (result) return result;
      delay(0.05);
    }
    throw Error(message);
  }
  function panel(background) {
    if (!exporting) return livePanel();
    var nativeMatches = listedSavePanels();
    if (audio && !nativeMatches.length) { var focused = focusedSavePanel(); if (focused) return focused; }
    if (nativeMatches.length !== 1 || ObjC.unwrap(nativeRead(nativeMatches[0], "AXModal")) !== true) throw Error("Expected one native export Save panel");
    return nativeElement(nativeMatches[0]);
  }
  function windowIdentity(window, background) {
    var title = window.name(), named = nativeWindows().filter(function (item) { return ObjC.unwrap(nativeRead(item, "AXTitle")) === title; });
    if (!named.length && (!exporting || audio)) { var focused = focusedDialog(); if (focused) named = [focused]; }
    if (named.length !== 1 || !$.CFEqual(named[0], window.native)) throw Error("Native Save window changed");
    var nativeList = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(background || audio ? 0 : 1, 0))).filter(function (item) {
      return item.kCGWindowOwnerPID === input.pid && item.kCGWindowName === title;
    });
    var visibleMatches=nativeList.filter(function (item) { return item.kCGWindowIsOnscreen===true; });
    if (visibleMatches.length) nativeList=visibleMatches;
    if (nativeList.length !== 1) throw Error("Native Save window identity is unavailable or ambiguous");
    return nativeList[0].kCGWindowNumber;
  }
  function purpose(window) {
    var text = find(window, "_messageTextField", "AXStaticText").value();
    var expected = expectedPurpose;
    if (text !== expected) throw Error("Unexpected native Save dialog purpose");
    return text;
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
    var app = $.AXUIElementCreateApplication(input.pid), windows = (audio ? nativeWindows() : items(read(app, "AXWindows"))).filter(function (window) {
      return text(window, "AXIdentifier") === "save-panel";
    });
    if (!windows.length && (!exporting || audio)) {
      var focused = read(app, "AXFocusedWindow");
      if (focused && text(focused, "AXIdentifier") === "save-panel") windows = [focused];
    }
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
  // Moves the column browser to target by file URL: visible columns, then a populated Where popup, then Go to Folder for a Set.
  function revealDirectory(target) {
    function read(element, key) {
      var value = Ref(), error = $.AXUIElementCopyAttributeValue(element, $(key), value);
      if (error === -25212 || error === -25205) return null;
      if (error) throw Error("Save directory attribute is unavailable: " + key);
      var result = ObjC.castRefToObject(value[0]);retained.push(result);return result;
    }
    function items(value) { var result = []; if (value) for (var i = 0; i < value.count; i++) result.push(value.objectAtIndex(i)); return result; }
    function text(element, key) { return ObjC.unwrap(read(element, key)); }
    function browserOf(element, depth) {
      if (depth > 5) return [];
      if (text(element, "AXIdentifier") === "ColumnView" && text(element, "AXRole") === "AXBrowser") return [element];
      if (["AXScrollArea", "AXOutline", "AXTable", "AXBrowser"].indexOf(text(element, "AXRole")) !== -1) return [];
      return items(read(element, "AXChildren")).reduce(function (out, child) { return out.concat(browserOf(child, depth + 1)); }, []);
    }
    function view() {
      var app = $.AXUIElementCreateApplication(input.pid), windows = (audio ? nativeWindows() : items(read(app, "AXWindows"))).filter(function (window) {
        return text(window, "AXIdentifier") === "save-panel";
      });
      if (!windows.length && (!exporting || audio)) {
        var focused = read(app, "AXFocusedWindow");
        if (focused && text(focused, "AXIdentifier") === "save-panel") windows = [focused];
      }
      if (windows.length !== 1) throw Error("Save directory window is unavailable");
      var browsers = browserOf(windows[0], 0);
      if (browsers.length !== 1) throw Error("Save directory requires the native column view");
      return browsers[0];
    }
    function fileURL(element) {
      var url = read(element, "AXURL");
      if (!url || !ObjC.unwrap(url.isFileURL)) return null;
      var path = ObjC.unwrap(url.filePathURL.path);
      return typeof path === "string" && path.charAt(0) === "/" ? path : null;
    }
    function rowsOf(browser) {
      var rows = [];
      items(read(browser, "AXColumns")).forEach(function (column) {
        items(read(column, "AXChildren")).filter(function (child) { return text(child, "AXRole") === "AXList"; }).forEach(function (list) {
          items(read(list, "AXChildren")).forEach(function (row) {
            var path = fileURL(row);
            if (!path) items(read(row, "AXChildren")).forEach(function (child) { if (!path) path = fileURL(child); });
            if (path) rows.push({ row: row, path: path });
          });
        });
      });
      return rows;
    }
    function covers(path) { return target === path || target.indexOf(path.replace(/\/+$/, "") + "/") === 0; }
    function press(row) {
      var opened = $.AXUIElementPerformAction(row, $("AXOpen"));
      if (opened === 0 || opened === -25204) return;
      var pressed = $.AXUIElementPerformAction(row, $("AXPress"));
      if (pressed !== 0 && pressed !== -25204) throw Error("Save folder row has no accessibility action; no key was sent");
    }
    function jumpAncestor(current) {
      var popups = [];
      process.windows().forEach(function (window) {
        try { if (attribute(window, "AXIdentifier") === "save-panel") popups.push(find(window, "where popup", "AXPopUpButton")); } catch (error) {}
      });
      if (popups.length !== 1 || typeof popups[0].menus !== "function" || !popups[0].menus().length) return false;
      var menuItems = popups[0].menus()[0].menuItems(), choices = [];
      for (var i = 0; i < menuItems.length; i++) {
        try { choices.push({ item: menuItems[i], name: menuItems[i].name() }); } catch (error) {}
      }
      var parts = target.split("/").filter(Boolean), built = "", match = null;
      for (var part = 0; part < parts.length; part++) {
        built += "/" + parts[part];
        if (built.length >= current.length || !covers(built)) continue;
        var hits = choices.filter(function (choice) { return choice.name === parts[part]; });
        if (hits.length === 1) match = hits[0];
      }
      if (!match) return false;
      match.item.actions.byName("AXPress").perform();
      if (audio) route("folder", "where");
      if (directoryPath() === current) throw Error("Save folder popup did not change the column; no key was sent");
      return true;
    }
    var jumped = false;
    for (var step = 0; step < 32; step++) {
      var current = directoryPath();
      if (current === target) { if (audio) route("folder", "column"); return; }
      var rows = rowsOf(view()).filter(function (entry) { return covers(entry.path) && entry.path.length > current.length; });
      rows.sort(function (a, b) { return b.path.length - a.path.length; });
      if (rows.length) { press(rows[0].row); if (audio) route("folder", "column"); continue; }
      if (jumped) throw Error("Save folder is not in the visible columns; no key was sent");
      jumped = true;
      if (!jumpAncestor(current)) {
        if (exporting) throw Error("Save folder is not in the visible columns; no key was sent");
        goToFolder(target);
      }
    }
    throw Error("Save folder is not in the visible columns; no key was sent");
  }
  // Go to Folder takes the exact path. Its keys go to Live only while Live is frontmost; raise_live brings it there.
  function goToFolder(target) {
    if (!process.frontmost()) throw Error("Save folder is not in the visible columns and Live is not frontmost; run raise_live, then retry; no key was sent");
    var save = panel(audio);
    if (save.sheets().length) throw Error("Unexpected sheet; no key was sent");
    save.attributes.byName("AXMain").value = true;
    if (attribute(save, "AXMain") !== true) throw Error("Save panel is not the main window; no key was sent");
    if (!process.frontmost()) throw Error("Live is not frontmost; no key was sent");
    events.keystroke("g", { using: ["command down", "shift down"] });
    var sheet = waitFor(function () { var sheets = save.sheets(); return sheets.length === 1 && sheets[0]; }, "Go to Folder did not appear");
    if (attribute(sheet, "AXIdentifier") !== "GoToWindow") throw Error("Unexpected folder sheet");
    var field = find(sheet, "PathTextField", "AXTextField");
    ownedFolderPath = field.value();
    field.value = target;
    ownedFolderPath = target;
    field.attributes.byName("AXFocused").value = true;
    if (field.value() !== target || attribute(field, "AXFocused") !== true) throw Error("Folder field is not focused on the requested path");
    if (!process.frontmost()) throw Error("Live lost the front before Go to Folder was confirmed; Return was not sent");
    events.keyCode(36);
    waitFor(function () { return save.sheets().length === 0; }, "Folder navigation is unverified");
    ownedFolderPath = null;
  }
  function showFolder(target) {
    if (directoryPath() === target) { if (audio) route("folder", "panel"); return; }
    revealDirectory(target);
    if (directoryPath() !== target) throw Error("Destination folder readback mismatch");
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
  function withPress(result) { if (audio) result.exportPress = exportPress; return result; }
  function cancelPrepared(expected, ownedFolderPath) {
    var save = panel(true);
    if (windowIdentity(save, true) !== input.windowId || purpose(save) !== input.purpose)
      throw Error("Prepared Save As window changed; no Cancel was pressed");
    ownState(save, expected);
    var sheets = save.sheets();
    if (sheets.length) {
      if (sheets.length !== 1 || attribute(sheets[0], "AXIdentifier") !== "GoToWindow" ||
          typeof ownedFolderPath !== "string" || find(sheets[0], "PathTextField", "AXTextField").value() !== ownedFolderPath)
        throw Error("Save sheet is not owned by this operation; no Cancel was pressed");
      find(sheets[0], "CloseButton", "AXButton").actions.byName("AXPress").perform();
      waitFor(function () { return save.sheets().length === 0; }, "Folder sheet closure is unverified", true);
    }
    noSheet(save);ownState(save, expected);
    if (windowIdentity(save, true) !== input.windowId || purpose(save) !== input.purpose)
      throw Error("Prepared Save As window changed; no Cancel was pressed");
    var button = find(save, "CancelButton", "AXButton");
    if (!button.enabled()) throw Error("Cancel is disabled");
    button.actions.byName("AXPress").perform();
    waitFor(function () {
      if (process.windows().some(function (window) { return attribute(window, "AXIdentifier") === "save-panel"; }) || (!exporting || audio) && livePanelOpen()) return false;
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
  if (audio) waitFor(function () {
    try { return windowIdentity(panel(true), true) === input.windowId; } catch (error) { return false; }
  }, "Prepared export Save window is not observable", true);
  if (input.action === "adoptAudioExport" || input.action === "adoptMidiExport") {
    var exportSave = panel(audio);noSheet(exportSave);
    if (windowIdentity(exportSave, audio) !== input.windowId) throw Error("Native export Save window changed");
    purpose(exportSave);
    if (typeof input.parent !== "string" || input.parent.charAt(0) !== "/") throw Error("Export directory is required");
    var shown = null;
    try { shown = directoryPath(); } catch (error) { if (audio) exportPress.folderReadError = String(error.message || error).slice(0, 300); }
    if (audio && typeof shown === "string" && input.relocate === true && shown !== input.parent) {
      route("folder", "panel");
      return JSON.stringify(withPress({ prepared: true, windowId: input.windowId, purpose: purpose(exportSave), panelState: panelState(exportSave) }));
    }
    showFolder(input.parent);
    if (windowIdentity(exportSave, audio) !== input.windowId) throw Error("Native export Save window changed");
    return JSON.stringify(withPress({ prepared: true, windowId: input.windowId, purpose: purpose(exportSave), panelState: panelState(exportSave) }));
  }
  if (input.action === "prepare") {
    if (process.windows().some(function (window) {
      return attribute(window, "AXModal") === true || window.sheets().length > 0;
    }) || focusedDialog()) throw Error("Dismiss the existing Live dialog before Save As");
    var menu = process.menuBars()[0].menuBarItems.byName("File").menus()[0].menuItems.byName("Save Live Set As...");
    if (!menu.exists() || !menu.enabled()) throw Error("Live Set Save As menu is unavailable (requires English Live)");
    menu.actions.byName("AXPress").perform();
    var save;
    try {
      save = waitFor(function () { try { return livePanel(); } catch (error) { return null; } }, "Save As panel did not appear", true);
      var windowId = waitFor(function () {
        try { return windowIdentity(save, true); } catch (error) { return null; }
      }, "Native Save window identity is unavailable or ambiguous", true);
      return JSON.stringify({ prepared: true, windowId: windowId, purpose: purpose(save), panelState: panelState(save) });
    } catch (error) {
      // No dialog was open before the menu press, so a Save panel open now belongs to this request.
      var own = waitFor(function () { try { return livePanel(); } catch (busy) { return null; } },
        "Save As panel is not observable and may still be open", true);
      find(own, "CancelButton", "AXButton").actions.byName("AXPress").perform();
      waitFor(function () {
        try { return !livePanelOpen(); } catch (busy) { return false; }
      }, "Save As panel closure is unverified", true);
      return JSON.stringify({ prepared: false, error: error.message, recovery: { status: "cancelled", savePressed: false } });
    }
  }
  if (input.action !== "commit") throw Error("Unknown Save As action");
  var ownedState = input.panelState, ownedFolderPath = null, saveAttempted = false;
  try {
    var save = panel(audio);noSheet(save);sameState(save, ownedState);
    if (windowIdentity(save, audio) !== input.windowId || purpose(save) !== input.purpose)
      throw Error("Prepared Save As window changed; no Save was pressed");
    showFolder(input.parent);
    ownedFolderPath = null;ownedState = panelState(save);
    var name = find(save, "saveAsNameTextField", "AXTextField");
    name.value = input.name;
    // Own the edit before checking it, so a mismatch still closes this panel.
    ownedState = panelState(save);
    if (ownedState.name !== input.name) throw Error("Save filename readback mismatch");
    noSheet(save);
    var button = find(save, "OKButton", "AXButton");
    // Audio Save readiness is checked immediately before its press.
    if (!audio) waitFor(function () { return button.enabled(); }, "Save is disabled", false, 40);
    if (windowIdentity(save, audio) !== input.windowId || purpose(save) !== input.purpose)
      throw Error("Prepared Save As window changed; no Save was pressed");
    if (exporting) {
      if (audio && directoryPath() !== input.parent) throw Error("Export directory changed; no Save was pressed");
      var directoryInfo = $.NSFileManager.defaultManager.attributesOfItemAtPathError($(input.parent), null);
      if (!input.parentIdentity || ObjC.unwrap(directoryInfo.objectForKey($("NSFileSystemNumber")).stringValue) !== input.parentIdentity.dev ||
          ObjC.unwrap(directoryInfo.objectForKey($("NSFileSystemFileNumber")).stringValue) !== input.parentIdentity.ino)
        throw Error("Export directory identity changed; no Save was pressed");
      var exportDestination = $(input.parent + "/" + input.name);
      var linkDestination = ObjC.unwrap($.NSFileManager.defaultManager.destinationOfSymbolicLinkAtPathError(exportDestination, null));
      if ($.NSFileManager.defaultManager.fileExistsAtPath(exportDestination) || typeof linkDestination === "string")
        throw Error("Export destination appeared; no Save was pressed");
    }
    if (!button.enabled()) throw Error("Save is disabled; no Save was pressed");
    saveAttempted = true;
    if (audio) {
      $.AXUIElementSetMessagingTimeout(button.native, 0.5);
      var pressed = $.AXUIElementPerformAction(button.native, $("AXPress"));exportPress.axResult = pressed;
      if (pressed !== 0 && pressed !== -25204 && pressed !== -25200) throw Error("Native export Save press was refused (" + pressed + "); no key was sent");
      route("save", "axPress");
    } else button.actions.byName("AXPress").perform();
    return JSON.stringify(withPress({ savePressed: true }));
  } catch (error) {
    var recovery = { status: "unavailable", reason: "Save button outcome is unknown; inspect Live and the destination" };
    if (!saveAttempted) {
      try {
        var cancelled = cancelPrepared(ownedState, ownedFolderPath);
        recovery = { status: "cancelled", windowId: cancelled.windowId, savePressed: false };
      } catch (cleanupError) { recovery = { status: "unavailable", reason: String(cleanupError.message || cleanupError).slice(0,600) }; }
    }
    return JSON.stringify(withPress({ error: String(error.message || error).slice(0,600), savePressed: saveAttempted ? null : false,
      recovery: recovery }));
  }
}
