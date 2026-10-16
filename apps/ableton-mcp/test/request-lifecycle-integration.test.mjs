import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createConfiguredService } from "../src/runtime.mjs";
import { runStdio } from "../src/server.mjs";

test("MCP cancellation prevents a confirmed queued write through the production Unix bridge", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "ab-lifecycle-"));
  const path = join(directory, "bridge.sock");
  const driver = spawn("python3", [new URL("./fixtures/lifecycle-bridge.py", import.meta.url).pathname, path],
    { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  driver.stderr.on("data", chunk => { stderr += chunk; });
  const lines = createInterface({ input: driver.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false, stderr);
    return JSON.parse(line.value);
  };
  const command = async name => { driver.stdin.write(`${name}\n`); return next(); };
  t.after(async () => {
    driver.stdin.end("stop\n");
    if (driver.exitCode === null) {
      const timer = setTimeout(() => driver.kill(), 1000);
      await once(driver, "exit");
      clearTimeout(timer);
    }
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await next(), { ready: true });
  const runtime = createConfiguredService({ ABLETON_MCP_BRIDGE_SOCKET: path });
  t.after(() => runtime.close());
  const input = new PassThrough(), output = new PassThrough();
  const replies = createInterface({ input: output })[Symbol.asyncIterator]();
  const running = runStdio({ service: runtime.service, input, output });
  const write = request => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
  const args = { tempo: 130, expectedStateVersion: 1 };
  write({ id: 1, method: "tools/call", params: { name: "set_tempo", arguments: args } });
  assert.equal((await command("next")).queuedMethod, "get_live_state");
  await command("drain");
  const plan = JSON.parse((await replies.next()).value).result.structuredContent;
  assert.equal(plan.dryRun, true);
  write({ id: 2, method: "tools/call", params: { name: "set_tempo", arguments: { ...args, dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash } } });
  assert.equal((await command("next")).queuedMethod, "get_live_state");
  await command("drain");
  assert.equal((await command("next")).queuedMethod, "set_tempo");
  write({ method: "notifications/cancelled", params: { requestId: 2 } });
  assert.deepEqual(await command("cancelled"), { cancelled: true });
  assert.deepEqual(await command("drain"), { tempo: 120, stateVersion: 1 });
  write({ id: 3, method: "tools/call", params: { name: "get_live_state", arguments: {} } });
  assert.equal((await command("next")).queuedMethod, "get_live_state");
  await command("drain");
  const readback = JSON.parse((await replies.next()).value);
  assert.equal(readback.id, 3, "cancelled request must not produce a reply");
  assert.equal(readback.result.structuredContent.tempo, 120);
  input.end();
  await running;
});
