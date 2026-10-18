import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfiguredService } from "../src/runtime.mjs";
import { Catalog } from "../../../packages/nks-pipeline/src/catalog.mjs";
import { createRouter } from "../src/server.mjs";

test("configured runtime works without an NKS catalog", () => {
  const runtime = createConfiguredService({ ABLETON_MCP_BRIDGE_SOCKET: "/tmp/test-ableton-mcp.sock" });
  assert.equal(typeof runtime.service.call, "function");
  runtime.close();
});

test("runtime passes configured Splice roots to the listing tool", async () => {
  const root = await mkdtemp(join((await import("node:os")).tmpdir(), "splice-runtime-"));
  const runtime = createConfiguredService({ ABLETON_MCP_SPLICE_ROOTS: JSON.stringify([root]) });
  try {
    const result = await runtime.service.call("list_local_splice_roots", {});
    assert.equal(result.roots[0].available, true);
    assert.equal(result.roots[0].rootPath, await (await import("node:fs/promises")).realpath(root));
  } finally { runtime.close(); await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); }
});

test("preset metadata reports when no NKS catalog is configured", async () => {
  const runtime = createConfiguredService({ ABLETON_MCP_BRIDGE_SOCKET: "/tmp/test-ableton-mcp.sock" });
  await assert.rejects(
    () => runtime.service.call("get_preset_metadata", { presetId: "serum-2:a" }),
    /preset catalog is not configured/
  );
  runtime.close();
});

test("unconfigured preset search and product resource disclose setup and Live browser fallback", async () => {
  const runtime = createConfiguredService({ ABLETON_MCP_BRIDGE_SOCKET: join(tmpdir(), "absent-catalog-bridge.sock") });
  try {
    const result = await runtime.service.call("search_presets", { query: "Bass" });
    assert.deepEqual(result.presets, []);
    assert.equal(result.catalog.configured, false);
    assert.equal(result.catalog.setup.environmentVariable, "ABLETON_MCP_CATALOG_PATH");
    assert.equal(result.catalog.setup.restartServer, true);
    assert.equal(result.catalog.fallback.discoveryTool, "list_browser_roots");
    assert.equal(result.catalog.fallback.searchTool, "search_browser_items");
    const products = await runtime.service.readResource("nks://catalog/products");
    assert.deepEqual(products, { products: [], catalog: result.catalog });
  } finally { runtime.close(); }
});

test("unconfigured preset lookups explain configuration instead of claiming an unknown preset", async () => {
  const runtime = createConfiguredService({});
  try {
    for (const name of ["get_preset", "get_preset_metadata"]) {
      await assert.rejects(runtime.service.call(name, { presetId: "observed:missing" }), error => {
        assert.match(error.message, /preset catalog is not configured/);
        assert.match(error.message, /ABLETON_MCP_CATALOG_PATH/);
        assert.match(error.message, /search_browser_items/);
        return true;
      });
    }
    await assert.rejects(runtime.service.readResource("nks://catalog/presets/observed%3Amissing"), /not configured/);
  } finally { runtime.close(); }
});

test("configured empty and populated catalogs remain distinct from missing configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-catalog-status-"));
  const path = join(dir, "catalog.sqlite"), runtime = createConfiguredService({ ABLETON_MCP_CATALOG_PATH: path });
  try {
    assert.deepEqual(await runtime.service.call("search_presets", { query: "Bass" }), { presets: [], catalog: { configured: true } });
    assert.deepEqual(await runtime.service.readResource("nks://catalog/products"), { products: [], catalog: { configured: true } });
    await assert.rejects(runtime.service.call("get_preset", { presetId: "missing" }), /unknown preset missing/);
    const catalog = Catalog.open(path);
    try { catalog.upsert({ id: "local:bass", productSlug: "local", name: "Bass", bank: "Factory", subBank: "", author: "", sourceFingerprint: "fixture", state: "discovered" }); }
    finally { catalog.close(); }
    const result = await runtime.service.call("search_presets", { query: "Bass" });
    assert.deepEqual(result.catalog, { configured: true });
    assert.equal(result.presets[0].id, "local:bass");
    assert.equal((await runtime.service.call("get_preset", { presetId: result.presets[0].id })).preset.name, "Bass");
    assert.equal((await runtime.service.call("get_preset_metadata", { presetId: result.presets[0].id })).metadata.revision, 0);
    assert.equal((await runtime.service.readResource("nks://catalog/products")).products[0].count, 1);
    assert.equal((await runtime.service.call("search_presets", { query: "No match" })).catalog.configured, true);
  } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("MCP catalog responses preserve setup status and consistent lookup errors", async () => {
  const runtime = createConfiguredService({});
  try {
    const route = createRouter(runtime.service, { toolProfile: "core" });
    const search = await route({ id: 1, method: "tools/call", params: { name: "search_presets", arguments: { limit: 1 } } });
    assert.equal(search.result.structuredContent.catalog.configured, false);
    const lookup = await route({ id: 2, method: "tools/call", params: { name: "get_preset", arguments: { presetId: "missing" } } });
    assert.equal(lookup.result.isError, true);
    assert.match(lookup.result.content[0].text, /ABLETON_MCP_CATALOG_PATH/);
  } finally { runtime.close(); }
});

test("configured runtime opens the SQLite catalog and bridge client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-runtime-"));
  const runtime = createConfiguredService({
    ABLETON_MCP_CATALOG_PATH: join(dir, "catalog.sqlite"),
    ABLETON_MCP_BRIDGE_SOCKET: join(dir, "bridge.sock")
  });
  assert.equal(typeof runtime.service.call, "function");
  assert.equal(runtime.service.bridge.socketPath, join(dir, "bridge.sock"));
  runtime.close();
});

test("configured runtime lazily opens private browser metadata at the selected path", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-browser-metadata-"));
  const runtime = createConfiguredService({ ABLETON_MCP_BROWSER_METADATA_PATH: join(dir, "browser.sqlite") });
  try {
    assert.deepEqual(runtime.service.browserMetadata().search(), []);
  } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
