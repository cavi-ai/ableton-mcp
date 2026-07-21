import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfiguredService } from "../src/runtime.mjs";

test("configured runtime requires explicit catalog and socket paths", () => {
  assert.throws(() => createConfiguredService({}), /ABLETON_NKS_CATALOG_PATH/);
});

test("configured runtime opens the SQLite catalog and bridge client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-runtime-"));
  const runtime = createConfiguredService({
    ABLETON_NKS_CATALOG_PATH: join(dir, "catalog.sqlite"),
    CAVI_MCP_BRIDGE_SOCKET: join(dir, "bridge.sock")
  });
  assert.equal(typeof runtime.service.call, "function");
  runtime.close();
});
