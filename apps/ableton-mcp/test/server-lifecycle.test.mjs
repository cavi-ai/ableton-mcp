import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpAcceptanceClient } from "../../../scripts/acceptance/mcp-client.mjs";
const exec = promisify(execFile);
const cli = new URL("../src/cli.mjs", import.meta.url).pathname;

test("CLI restart replaces the worker and retains the host connection", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, ABLETON_MCP_FIXTURE: "1", ABLETON_MCP_SERVER_DIRECTORY: directory };
  const client = new McpAcceptanceClient({ env, timeoutMs: 10000 });
  t.after(() => client.close());
  const initialized = await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "restart-test", version: "1" } });
  const [filename] = await readdir(directory);
  const before = JSON.parse(await readFile(join(directory, filename), "utf8"));
  assert.equal((await fetch(`http://127.0.0.1:${before.port}/restart`, { method: "POST" })).status, 403);
  assert.ok((await client.call("list_live_scales")).scales.length > 10);
  client.child.stdin.write('{"jsonrpc":"2.0","id":999,"method":"ping"');
  await assert.rejects(exec(process.execPath, [cli, "restart", "--pid", String(client.child.pid), "--json"], { env }), /active requests/);
  assert.equal(JSON.parse(await readFile(join(directory, filename), "utf8")).workerPid, before.workerPid);
  client.child.stdin.write('}\n');
  await client.request("ping");
  const { stdout } = await exec(process.execPath, [cli, "restart", "--pid", String(client.child.pid), "--json"], { env });
  const result = JSON.parse(stdout);
  assert.equal(result.restarted, true);
  assert.equal(result.servers.length, 1);
  assert.notEqual(result.servers[0].workerPid, before.workerPid);
  assert.deepEqual(result.servers[0].serverIdentity, initialized._meta["ai.cavi/runtime"]);
  assert.ok((await client.call("list_live_scales")).scales.length > 10);
  assert.equal(client.closed, false);
  await client.close();
  assert.deepEqual(await readdir(directory), []);
});

test("restart requires an unambiguous registered server and never starts an unconnected one", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-no-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(exec(process.execPath, [cli, "restart", "--json"], {
    env: { ...process.env, ABLETON_MCP_SERVER_DIRECTORY: directory }
  }), /no managed server/);
});
