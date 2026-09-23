import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toolContracts } from "../apps/ableton-mcp/src/tool-contracts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(path.join(tmpdir(), "ableton-mcp-package-"));
const consumer = path.join(work, "consumer");

function npm(args, cwd) {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function exchange(command, args, env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`${path.basename(args[0] ?? command)} exited ${code}: ${stderr}`));
      else resolve(stdout.trim().split("\n").map((line) => JSON.parse(line)));
    });
    child.stdin.end(requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n") + "\n");
  });
}

const [{ filename }] = JSON.parse(npm(["pack", "--json", "--pack-destination", work], repoRoot));
mkdirSync(consumer);
writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
npm(["install", "--no-audit", "--no-fund", path.join(work, filename)], consumer);

const bin = path.join(consumer, "node_modules/.bin/ableton-mcp");
const installed = path.join(consumer, "node_modules/@cavi-ai/ableton-mcp");
const help = execFileSync(bin, ["help"], { encoding: "utf8" });
assert.match(help, /"serve"/u);

const listing = await exchange(bin, ["serve"], { ABLETON_MCP_BRIDGE_SOCKET: path.join(work, "absent.sock") }, [
  { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-e2e", version: "0" } } },
  { id: 2, method: "tools/list" },
  { id: 3, method: "resources/list" },
  { id: 4, method: "prompts/list" }
]);
assert.equal(listing[0].result.serverInfo.name, "ableton-mcp");
assert.equal(listing[1].result.tools.length, Object.keys(toolContracts).length);
assert.ok(listing[2].result.resources.length > 0);
assert.ok(listing[3].result.prompts.length > 0);

const fixture = await exchange(process.execPath, [path.join(installed, "apps/ableton-mcp/src/server.mjs")], { ABLETON_MCP_FIXTURE: "1" }, [
  { id: 1, method: "tools/call", params: { name: "search_presets", arguments: { query: "Deep" } } }
]);
assert.equal(fixture[0].result.content[0].type, "text");

const remoteScripts = path.join(work, "Remote Scripts");
execFileSync(bin, ["install", "--destination", remoteScripts, "--json"], { encoding: "utf8" });
const bridgeFiles = readdirSync(path.join(remoteScripts, "CaviMcpBridge")).sort();
assert.deepEqual(bridgeFiles, ["__init__.py", "bridge.py", "capabilities.json", "protocol.py"]);

const doctor = JSON.parse(execFileSync(bin, ["doctor", "--json"], {
  encoding: "utf8",
  env: { ...process.env, ABLETON_MCP_BRIDGE_SOCKET: path.join(work, "absent.sock") }
}));
assert.equal(doctor.ok, false);
assert.match(doctor.bridge.reason, /ENOENT/u);
assert.ok(!existsSync(path.join(installed, "apps/ableton-mcp/test")));

process.stdout.write(`${JSON.stringify({
  tarball: filename,
  tools: listing[1].result.tools.length,
  resources: listing[2].result.resources.length,
  prompts: listing[3].result.prompts.length,
  bridgeFiles
})}\n`);
rmSync(work, { recursive: true, force: true });
