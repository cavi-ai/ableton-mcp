// Read native document/menu evidence without activating Live or sending input.
function run(argv) {
  var input = JSON.parse(argv[0]), events = Application("System Events");
  var processes = events.applicationProcesses.whose({ unixId: input.pid })();
  if (processes.length !== 1 || processes[0].bundleIdentifier() !== "com.ableton.live")
    throw Error("Expected the exact Live process");
  var process = processes[0];
  function attribute(element, key) {
    try { return element.attributes.byName(key).value(); } catch (error) { return null; }
  }
  function document() {
    if (!process.frontmost()) throw Error("Live is not frontmost");
    var windows = process.windows();
    if (windows.some(function (window) { return attribute(window, "AXModal") !== false || window.sheets().length > 0; }))
      throw Error("Live has a dialog or unavailable modal state");
    var main = windows.filter(function (window) { return attribute(window, "AXMain") === true; });
    if (main.length !== 1 || typeof attribute(main[0], "AXDocument") !== "string" || !attribute(main[0], "AXDocument"))
      throw Error("Live document is unavailable or ambiguous");
    return attribute(main[0], "AXDocument");
  }
  var before = document();
  var file = process.menuBars()[0].menuBarItems.byName("File").menus()[0];
  var save = file.menuItems.byName("Save Live Set"), saveAs = file.menuItems.byName("Save Live Set As...");
  if (!save.exists() || !saveAs.exists() || saveAs.enabled() !== true)
    throw Error("Live Set menu is unavailable (requires English Live)");
  var enabled = save.enabled();
  if (typeof enabled !== "boolean" || document() !== before)
    throw Error("Live document or menu state changed during observation");
  return JSON.stringify({ documentURL: before, saveEnabled: enabled, saveAsEnabled: true });
}
