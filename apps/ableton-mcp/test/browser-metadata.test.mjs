import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserMetadataLibrary } from "../src/browser-metadata-library.mjs";
import { ToolService } from "../src/tool-service.mjs";

test("browser metadata persists exact item identity and rejects stale revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-metadata-"));
  const path = join(directory, "metadata.sqlite");
  const item = { root: "instruments", path: ["Operator"], uri: "ableton://operator" };
  try {
    const library = new BrowserMetadataLibrary({ path });
    assert.deepEqual(library.get(item), { favorite: false, tags: [], revision: 0 });
    assert.deepEqual(library.set(item, 0, { favorite: true, tags: [" Synth ", "synth", "FM"] }),
      { favorite: true, tags: ["fm", "synth"], revision: 1 });
    library.close();
    const reopened = new BrowserMetadataLibrary({ path });
    assert.deepEqual(reopened.get(item), { favorite: true, tags: ["fm", "synth"], revision: 1 });
    assert.throws(() => reopened.set(item, 0, { favorite: false }), /revision mismatch/);
    assert.deepEqual(reopened.get({ ...item, uri: "ableton://other" }), { favorite: false, tags: [], revision: 0 });
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("browser item metadata changes require live identity and a single-use confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-metadata-service-"));
  const library = new BrowserMetadataLibrary({ path: join(directory, "metadata.sqlite") });
  let uri = "ableton://operator";
  const service = new ToolService({ browserMetadata: library, bridge: { async request(method) {
    if (method !== "get_browser_items") throw new Error(method);
    return { stateVersion: 3, item: { name: "Operator", uri, loadable: true, folder: false } };
  } } });
  const args = { root: "instruments", path: ["Operator"], expectedMetadataRevision: 0, favorite: true };
  try {
    const before = await service.call("get_browser_item_metadata", { root: args.root, path: args.path });
    assert.equal(before.metadata.revision, 0);
    const dry = await service.call("set_browser_item_metadata", args);
    assert.equal(dry.plan.item.uri, uri);
    uri = "ableton://reindexed";
    await assert.rejects(() => service.call("set_browser_item_metadata", { ...args, dryRun: false,
      confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash }), /identity|plan hash/);
    uri = "ableton://operator";
    const applied = await service.call("set_browser_item_metadata", { ...args, dryRun: false,
      confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
    assert.equal(applied.observed.favorite, true);
    await assert.rejects(() => service.call("set_browser_item_metadata", { ...args, dryRun: false,
      confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash }), /confirmation|revision mismatch/);
  } finally { library.close(); await rm(directory, { recursive: true, force: true }); }
});

test("private browser metadata search filters tags and favorites without claiming Live verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-metadata-search-"));
  const library = new BrowserMetadataLibrary({ path: join(directory, "metadata.sqlite") });
  try {
    library.set({ root: "instruments", path: ["Operator"], uri: "query:Synths#Operator" }, 0,
      { favorite: true, tags: ["synth", "fm"] });
    library.set({ root: "audio_effects", path: ["Delay"], uri: "query:Effects#Delay" }, 0,
      { favorite: true, tags: ["fx"] });
    assert.deepEqual(library.search({ root: "instruments", favorite: true, tags: ["synth"] }), [{
      root: "instruments", path: ["Operator"], uri: "query:Synths#Operator",
      metadata: { favorite: true, tags: ["fm", "synth"], revision: 1 }, liveVerified: false
    }]);
    assert.deepEqual(library.search({ tags: ["unknown"] }), []);
  } finally { library.close(); await rm(directory, { recursive: true, force: true }); }
});
