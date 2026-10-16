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
  constructor({ platform = process.platform, run = execFileAsync, appPath, bridgeSocketPath } = {}) {
    this.platform = platform;
    this.run = run;
    this.configuredAppPath = appPath;
    this.bridgeSocketPath = bridgeSocketPath;
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

  async launchContext() {
    this.#requireMac();
    const configured = this.configuredAppPath;
    if (typeof configured !== "string" || !isAbsolute(configured) || !configured.endsWith(".app"))
      throw new Error("set ABLETON_MCP_LIVE_APP_PATH to the Ableton Live .app bundle before launch");
    if (this.bridgeSocketPath !== undefined && (typeof this.bridgeSocketPath !== "string" || !isAbsolute(this.bridgeSocketPath)))
      throw new Error("launch requires an absolute bridge socket path");
    const path = await realpath(configured);
    if (!path.endsWith(".app") || !(await stat(path)).isDirectory()) throw new Error("Ableton Live app bundle is invalid");
    const file = async target => {
      const canonical = await realpath(target), info = await stat(canonical, { bigint: true });
      if (!info.isFile()) throw new Error("Ableton Live app metadata and binary must be regular files");
      return { path: canonical, size: Number(info.size), mtimeNs: String(info.mtimeNs) };
    };
    const infoFile = await file(`${path}/Contents/Info.plist`);
    const metadata = JSON.parse((await this.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoFile.path],
      { timeout: 5000, maxBuffer: 65536 })).stdout);
    if (metadata.CFBundleIdentifier !== "com.ableton.live" || metadata.CFBundleExecutable !== "Live")
      throw new Error("configured bundle is not Ableton Live");
    const binary = await file(`${path}/Contents/MacOS/Live`);
    if (((await stat(binary.path, { bigint: true })).mode & 0o111n) === 0n)
      throw new Error("Ableton Live binary is not executable");
    const processes = (await this.run("/bin/ps", ["-axo", "pid=,comm="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const running = [];
    for (const line of processes.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/u);
      if (!match || (match[2] !== "Live" && !match[2].endsWith("/Live"))) continue;
      let executable = match[2];
      try { executable = await realpath(executable); } catch { /* Keep unknown Live paths visible and refuse another launch. */ }
      running.push({ pid: Number(match[1]), path: executable });
    }
    return { app: { path, executable: binary.path, version: metadata.CFBundleShortVersionString ?? null, infoFile, binary }, running,
      environment: this.bridgeSocketPath ? { ABLETON_MCP_BRIDGE_SOCKET: this.bridgeSocketPath } : {} };
  }

  async open(appPath, path, { launch = false } = {}) {
    this.#requireMac();
    const environment = launch && this.bridgeSocketPath ? ["--env", `ABLETON_MCP_BRIDGE_SOCKET=${this.bridgeSocketPath}`] : [];
    await this.run("/usr/bin/open", [...(launch ? ["-n"] : []), "-a", appPath, ...environment, path]);
  }

  async save(appPath) {
    this.#requireMac();
    await this.run("/usr/bin/open", ["-a", appPath]);
    await this.run("/usr/bin/osascript", ["-e", saveScript]);
  }
}
