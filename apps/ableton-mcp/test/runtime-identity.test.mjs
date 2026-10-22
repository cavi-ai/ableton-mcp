import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeIdentity, runtimeIdentity } from "../src/runtime-identity.mjs";
import { runCli } from "../src/cli.mjs";
import { createRouter } from "../src/server.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "runtime-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/runtime"), { recursive: true });
  await mkdir(join(root, "ableton"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@cavi-ai/ableton-mcp", version: "1.2.3",
    files: ["apps/runtime", "ableton/bridge.py", "README.md"] }));
  await writeFile(join(root, "apps/runtime/a.mjs"), "export const a = 1;\n");
  await writeFile(join(root, "ableton/bridge.py"), "VERSION = '1.2.3'\n");
  await writeFile(join(root, "README.md"), "Readme\n");
  return root;
}

test("runtime fingerprints identify packaged code independently of checkout path and documentation", async t => {
  const a = await fixture(t), b = await fixture(t);
  const first = createRuntimeIdentity(a);
  assert.deepEqual(createRuntimeIdentity(b), first);
  assert.equal(first.version, "1.2.3");
  assert.match(first.sourceSha256, /^[a-f0-9]{64}$/);
  await writeFile(join(b, "README.md"), "Updated documentation\n");
  assert.deepEqual(createRuntimeIdentity(b), first);
  await writeFile(join(b, "apps/runtime/a.mjs"), "export const a = 2;\n");
  assert.notEqual(createRuntimeIdentity(b).sourceSha256, first.sourceSha256);
});

test("runtime identity refuses missing code, symlinks and package paths outside its root", async t => {
  const root = await fixture(t);
  await rm(join(root, "apps/runtime/a.mjs"));
  await symlink(join(root, "README.md"), join(root, "apps/runtime/a.mjs"));
  assert.throws(() => createRuntimeIdentity(root), /symlink/);
  await rm(join(root, "apps/runtime/a.mjs"));
  await rm(join(root, "ableton/bridge.py"));
  assert.throws(() => createRuntimeIdentity(root), /ENOENT|missing/);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", files: ["apps/../../outside"] }));
  assert.throws(() => createRuntimeIdentity(root), /package path/);
});

test("CLI identity and MCP expose the same running fingerprint without opening a Live connection", async () => {
  let opened = false;
  const result = await runCli(["identity", "--json"], { stdout() {}, runtimeFactory() { opened = true; throw Error("must not open Live"); } });
  assert.deepEqual(result, runtimeIdentity()); assert.equal(opened, false);
  const route = createRouter({ call: async () => ({ stateVersion: 1, setFingerprint: "set-a" }) });
  const initialized = await route({ id: 1, method: "initialize" });
  assert.deepEqual(initialized.result._meta["ai.cavi/runtime"], result);
  const state = await route({ id: 2, method: "tools/call", params: { name: "get_live_state", arguments: {} } });
  assert.deepEqual(state.result.structuredContent.serverIdentity, result);
  assert.equal(state.result.structuredContent.setFingerprint, "set-a");
});
