import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { isMainModule, parseCli, runCli } from "../src/cli.mjs";

test("CLI parses commands and global JSON output", () => {
  assert.deepEqual(parseCli(["doctor", "--json"]), { command: "doctor", json: true, args: [] });
  assert.deepEqual(parseCli(["install", "--live-version", "12.4"]), {
    command: "install",
    json: false,
    args: ["--live-version", "12.4"]
  });
});

test("CLI recognizes an npm-style executable symlink as the main module", async () => {
  const root = await mkdtemp(join(tmpdir(), "ableton-mcp-bin-"));
  const target = new URL("../src/cli.mjs", import.meta.url);
  const link = join(root, "ableton-mcp");
  await symlink(target, link);
  assert.equal(isMainModule(pathToFileURL(target.pathname).href, link), true);
});

test("install copies the packaged Remote Script without deleting unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ableton-mcp-cli-"));
  const source = join(root, "source");
  const destination = join(root, "Remote Scripts");
  const writes = [];
  const fs = {
    async cp(from, to, options) { writes.push({ from, to, options }); },
    async mkdir(path, options) { writes.push({ mkdir: path, options }); }
  };
  const output = [];
  const result = await runCli(["install", "--destination", destination], {
    fs,
    sourceRoot: source,
    platform: "darwin",
    home: root,
    stdout: (line) => output.push(line)
  });
  assert.equal(result.installed, true);
  assert.equal(result.destination, join(destination, "CaviMcpBridge"));
  assert.deepEqual(writes[0], { mkdir: destination, options: { recursive: true } });
  assert.equal(writes[1].from, join(source, "ableton", "Remote Scripts", "CaviMcpBridge"));
  assert.equal(writes[1].options.recursive, true);
  assert.equal("force" in writes[1].options, false);
});

test("doctor reports actionable configuration without requiring the private NKS catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "ableton-mcp-doctor-"));
  const result = await runCli(["doctor", "--json"], {
    platform: "darwin",
    home: root,
    env: { CAVI_MCP_BRIDGE_SOCKET: join(root, "missing.sock") },
    stdout: () => {}
  });
  assert.equal(result.catalog.configured, false);
  assert.equal(result.bridge.connected, false);
  assert.equal(result.ok, false);
});

test("uninstall removes only the named CaviMcpBridge directory", async () => {
  const removed = [];
  const root = "/Users/test/Music/Ableton/User Library/Remote Scripts";
  const result = await runCli(["uninstall", "--destination", root], {
    fs: {
      async rm(path, options) { removed.push({ path, options }); }
    },
    platform: "darwin",
    home: "/Users/test",
    stdout: () => {}
  });
  assert.equal(result.removed, true);
  assert.deepEqual(removed, [{
    path: join(root, "CaviMcpBridge"),
    options: { recursive: true, force: false }
  }]);
});

test("call and resource expose the MCP service through the CLI", async () => {
  const calls = [];
  const runtimeFactory = () => ({
    service: {
      async call(name, args) { calls.push({ name, args }); return { tracks: [] }; },
      async readResource(uri) { calls.push({ uri }); return { scenes: [] }; }
    },
    close() { calls.push({ closed: true }); }
  });
  const output = [];
  await runCli(["call", "list_tracks", "--args", "{}", "--json"], {
    runtimeFactory,
    stdout: (line) => output.push(line)
  });
  await runCli(["resource", "ableton://set/scenes", "--json"], {
    runtimeFactory,
    stdout: (line) => output.push(line)
  });
  assert.deepEqual(calls, [
    { name: "list_tracks", args: {} },
    { closed: true },
    { uri: "ableton://set/scenes" },
    { closed: true }
  ]);
  assert.equal(JSON.parse(output[0]).tracks.length, 0);
});
