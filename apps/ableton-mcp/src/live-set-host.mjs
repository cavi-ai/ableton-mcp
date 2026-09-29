import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

const execFileAsync = promisify(execFile);
const scriptDirectorySuffix = "/Contents/App-Resources/MIDI Remote Scripts/CaviMcpBridge";
const saveScript = `tell application "System Events"
  set frontApp to first application process whose frontmost is true
  if bundle identifier of frontApp is not "com.ableton.live" then error "Ableton Live is not frontmost"
  keystroke "s" using command down
end tell`;

export class MacLiveSetHost {
  constructor({ platform = process.platform, run = execFileAsync, appPath } = {}) {
    this.platform = platform;
    this.run = run;
    this.configuredAppPath = appPath;
  }

  #requireMac() {
    if (this.platform !== "darwin") throw new Error("Live Set file control is macOS only");
  }

  appPathFor(live) {
    this.#requireMac();
    const path = this.configuredAppPath ?? (typeof live.scriptDirectory === "string" &&
      live.scriptDirectory.endsWith(scriptDirectorySuffix)
      ? live.scriptDirectory.slice(0, -scriptDirectorySuffix.length) : null);
    if (!path || !isAbsolute(path) || !path.endsWith(".app"))
      throw new Error("set ABLETON_MCP_LIVE_APP_PATH to the running Ableton Live .app bundle");
    return path;
  }

  async existingSet(path) {
    if (typeof path !== "string" || !isAbsolute(path) || !/\.als$/iu.test(path))
      throw new Error("Live Set path must be an absolute .als file");
    let canonical;
    try { canonical = await realpath(path); }
    catch (error) { if (error.code === "ENOENT") throw new Error("Live Set file is not available"); throw error; }
    if (!/\.als$/iu.test(canonical) || !(await stat(canonical)).isFile())
      throw new Error("Live Set path must resolve to a regular .als file");
    return canonical;
  }

  async fileInfo(path) {
    const canonical = await this.existingSet(path);
    const { size, mtimeMs } = await stat(canonical);
    return { path: canonical, size, mtimeMs };
  }

  async open(appPath, path) {
    this.#requireMac();
    await this.run("/usr/bin/open", ["-a", appPath, path]);
  }

  async save(appPath) {
    this.#requireMac();
    await this.run("/usr/bin/open", ["-a", appPath]);
    await this.run("/usr/bin/osascript", ["-e", saveScript]);
  }
}
