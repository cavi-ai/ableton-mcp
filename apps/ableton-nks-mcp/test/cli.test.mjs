import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { isMainModule, parseCli, runCli } from "../src/cli.mjs";
import { ToolService } from "../src/tool-service.mjs";

test("CLI validation preserves real guarded confirmation execution", async () => {
  let tempo = 120;
  const service = new ToolService({ catalog: {}, bridge: { request: async (method, args) => {
    if (method === "get_live_state") return { stateVersion: 1, tempo };
    if (method === "set_tempo") { tempo = args.tempo; return { stateVersion: 2, tempo }; }
    throw new Error(`unexpected method ${method}`);
  } } });
  const dependencies = { runtimeFactory: () => ({ service, close() {} }), stdout: () => {} };
  const args = { expectedStateVersion: 1, tempo: 128 };
  const dry = await runCli(["call", "set_tempo", "--args", JSON.stringify(args)], dependencies);
  assert.equal(tempo, 120);
  const result = await runCli(["call", "set_tempo", "--args", JSON.stringify({ ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash })], dependencies);
  assert.equal(result.dryRun, false);
  assert.equal(tempo, 128);
});

test("CLI parses commands and global JSON output", () => {
  assert.deepEqual(parseCli(["doctor", "--json"]), { command: "doctor", json: true, args: [] });
  assert.deepEqual(parseCli(["install", "--live-version", "12.4"]), {
    command: "install",
    json: false,
    args: ["--live-version", "12.4"]
  });
});

test("CLI rejects malformed arguments before opening runtime resources", async () => {
  let opened = 0;
  const runtimeFactory = () => { opened++; return { service: { call: async () => ({}) }, close() {} }; };
  for (const encoded of ["{", "null", "[]", '{"expectedStateVersion":1,"trackId":"track-0","armed":"yes"}',
    '{"expectedStateVersion":1,"trackId":"track-0","armed":true,"extra":1}']) {
    await assert.rejects(() => runCli(["call", "arm_track", "--args", encoded], { runtimeFactory, stdout: () => {} }));
  }
  await assert.rejects(() => runCli(["call", "not_a_tool"], { runtimeFactory, stdout: () => {} }), /unknown tool/);
  assert.equal(opened, 0);
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
    async mkdir(path, options) { writes.push({ mkdir: path, options }); },
    async rm(path, options) { writes.push({ rm: path, options }); }
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
  assert.deepEqual(writes[1], { rm: join(destination, "CaviMcpBridge", "__pycache__"),
    options: { recursive: true, force: true } });
  assert.equal(writes[2].from, join(source, "ableton", "Remote Scripts", "CaviMcpBridge"));
  assert.equal(writes[2].options.recursive, true);
  assert.equal("force" in writes[2].options, false);
});

test("install excludes packaged tests and Python caches while copying runtime bridge files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ableton-mcp-install-filter-"));
  const source = join(root, "source", "ableton", "Remote Scripts", "CaviMcpBridge");
  const destination = join(root, "installed");
  try {
    await mkdir(join(source, "tests", "__pycache__"), { recursive: true });
    await mkdir(join(source, "__pycache__"));
    await writeFile(join(source, "bridge.py"), "runtime bridge\n");
    await writeFile(join(source, "tests", "test_dispatch.py"), "test-only\n");
    await writeFile(join(source, "__pycache__", "bridge.pyc"), "cache-only\n");
    await runCli(["install", "--destination", destination], { sourceRoot: join(root, "source"), stdout: () => {} });
    assert.equal(await readFile(join(destination, "CaviMcpBridge", "bridge.py"), "utf8"), "runtime bridge\n");
    await assert.rejects(stat(join(destination, "CaviMcpBridge", "tests")), { code: "ENOENT" });
    await assert.rejects(stat(join(destination, "CaviMcpBridge", "__pycache__")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("doctor verifies bridge version and capabilities through a real probe", async () => {
  const result = await runCli(["doctor", "--json"], {
    platform: "darwin",
    home: "/Users/test",
    bridgeProbe: async () => ({
      bridgeVersion: "0.1.0",
      capabilities: ["list_scenes", "transport_play"]
    }),
    stdout: () => {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.bridge.missingCapabilities.includes("get_track_routing"), true);
  assert.equal(result.bridge.missingCapabilities.includes("list_scenes"), false);
  assert.equal(result.bridge.version, "0.1.0");
  assert.equal(result.bridge.capabilities.includes("list_scenes"), true);
});

test("doctor rejects a stale bridge handshake", async () => {
  const result = await runCli(["doctor", "--json"], {
    platform: "darwin",
    home: "/Users/test",
    bridgeProbe: async () => ({ stateVersion: 1 }),
    stdout: () => {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.bridge.reason, "outdated bridge: expected 0.1.0");
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
  const runtimeFactory = (environment, options) => ({
    service: {
      async call(name, args) { calls.push({ name, args }); return { tracks: [] }; },
      async readResource(uri) { calls.push({ uri }); return { scenes: [] }; }
    },
    close() { calls.push({ closed: true, options }); }
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
    { closed: true, options: { persistentConfirmations: true } },
    { uri: "ableton://set/scenes" },
    { closed: true, options: undefined }
  ]);
  assert.equal(JSON.parse(output[0]).tracks.length, 0);
});

test("prompts commands render templates without opening a runtime", async () => {
  const opened = [];
  const runtimeFactory = () => { opened.push(true); return { close() {} }; };
  const output = [];
  const listed = await runCli(["prompts", "--json"], { runtimeFactory, stdout: (line) => output.push(line) });
  assert.equal(listed.prompts.length, 5);
  const rendered = await runCli(["prompt", "produce-drum-pattern", "--args", '{"trackId":"track-3"}', "--json"],
    { runtimeFactory, stdout: () => {} });
  assert.match(rendered.messages[0].content.text, /track-3/);
  await assert.rejects(() => runCli(["prompt", "produce-drum-pattern"], { runtimeFactory, stdout: () => {} }), /missing required prompt argument/);
  await assert.rejects(() => runCli(["prompt"], { runtimeFactory, stdout: () => {} }), /requires a template name/);
  assert.deepEqual(opened, []);
});
