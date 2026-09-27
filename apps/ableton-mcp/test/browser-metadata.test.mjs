import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile, symlink } from "node:fs/promises";
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

test("cross-root Live search joins private metadata by exact URI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-search-metadata-"));
  const library = new BrowserMetadataLibrary({ path: join(directory, "metadata.sqlite") });
  let uri = "query:serum";
  const calls = [];
  const service = new ToolService({ browserMetadata: library, bridge: { async request(method, params) {
    calls.push({ method, params });
    return { stateVersion: 4, results: [{ root: "plugins", path: ["Serum"], uri,
      name: "Serum", loadable: true, folder: false }], truncated: false };
  } } });
  try {
    library.set({ root: "plugins", path: ["Serum"], uri }, 0, { favorite: true, tags: ["bass"] });
    const args = { query: "Serum", roots: ["plugins"], includeMetadata: true };
    const found = await service.call("search_browser_roots", args);
    assert.deepEqual(found.results[0].metadata, { favorite: true, tags: ["bass"], revision: 1 });
    assert.equal(found.metadataSource, "private_mcp");
    assert.equal(calls[0].params.includeMetadata, undefined);
    uri = "query:serum-new";
    const moved = await service.call("search_browser_roots", args);
    assert.deepEqual(moved.results[0].metadata, { favorite: false, tags: [], revision: 0 });
  } finally { library.close(); await rm(directory, { recursive: true, force: true }); }
});

test("subtree Live search optionally joins private tags without sending metadata options to Live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-subtree-metadata-"));
  const library = new BrowserMetadataLibrary({ path: join(directory, "metadata.sqlite") });
  const calls = [];
  const service = new ToolService({ browserMetadata: library, bridge: { async request(method, params) {
    calls.push({ method, params });
    return { stateVersion: 4, root: "plugins", path: ["VST3"], query: "Serum",
      results: [{ path: ["VST3", "Xfer", "Serum"], uri: "plugin:serum-vst3",
        name: "Serum", loadable: true, folder: false }] };
  } } });
  try {
    library.set({ root: "plugins", path: ["VST3", "Xfer", "Serum"], uri: "plugin:serum-vst3" }, 0,
      { favorite: true, tags: ["lead"] });
    const args = { root: "plugins", path: ["VST3"], query: "Serum", includeMetadata: true };
    const result = await service.call("search_browser_items", args);
    assert.deepEqual(result.results[0].metadata, { favorite: true, tags: ["lead"], revision: 1 });
    assert.equal(result.metadataSource, "private_mcp");
    assert.equal(result.nativeLiveCollectionsModified, false);
    assert.equal(calls[0].params.includeMetadata, undefined);
    const plain = await service.call("search_browser_items", { ...args, includeMetadata: false });
    assert.equal(plain.results[0].metadata, undefined);
    await assert.rejects(() => service.call("search_browser_items", { ...args, includeMetadata: "yes" }), /includeMetadata/);
  } finally { library.close(); await rm(directory, { recursive: true, force: true }); }
});

test("browser pages optionally join child metadata using the exact parent path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-page-metadata-"));
  const library = new BrowserMetadataLibrary({ path: join(directory, "metadata.sqlite") });
  const calls = [];
  const service = new ToolService({ browserMetadata: library, bridge: { async request(method, params) {
    calls.push({ method, params });
    return { stateVersion: 4, root: params.root, path: params.path, totalChildren: 1,
      nextOffset: null, item: { name: "VST3", uri: "folder:vst3", folder: true, loadable: false },
      children: [{ name: "Serum", uri: "plugin:serum-vst3", folder: false, loadable: true }] };
  } } });
  try {
    library.set({ root: "plugins", path: ["VST3", "Serum"], uri: "plugin:serum-vst3" }, 0,
      { favorite: true, tags: ["bass"] });
    for (const name of ["get_browser_items", "get_factory_browser_items"]) {
      const result = await service.call(name, { root: "plugins", path: ["VST3"], includeMetadata: true });
      assert.deepEqual(result.children[0].metadata, { favorite: true, tags: ["bass"], revision: 1 });
      assert.equal(result.metadataSource, "private_mcp");
      assert.equal(result.nativeLiveCollectionsModified, false);
    }
    assert.ok(calls.every(call => call.params.includeMetadata === undefined));
    const plain = await service.call("get_browser_items", { root: "plugins", path: ["VST3"] });
    assert.equal(plain.children[0].metadata, undefined);
    await assert.rejects(() => service.call("get_browser_items", {
      root: "plugins", path: ["VST3"], includeMetadata: 1 }), /includeMetadata/);
  } finally { library.close(); await rm(directory, { recursive: true, force: true }); }
});

test("local Splice search includes private tags and favorites by exact file identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "splice-search-metadata-"));
  const library = new BrowserMetadataLibrary({ path: join(directory, "metadata.sqlite") });
  const sample = join(directory, "Kick.wav");
  try {
    await writeFile(sample, "audio");
    library.set({ root: "local_splice", path: [await realpath(directory), "Kick.wav"], uri: await realpath(sample) }, 0,
      { favorite: true, tags: ["drums"] });
    const service = new ToolService({ browserMetadata: library });
    const result = await service.call("search_local_splice_samples", {
      rootPath: directory, query: "kick", includeMetadata: true,
    });
    assert.deepEqual(result.samples[0].metadata, { favorite: true, tags: ["drums"], revision: 1 });
    assert.equal(result.metadataSource, "private_mcp");
  } finally { library.close(); await rm(directory, { recursive: true, force: true }); }
});

test("local Splice metadata keeps one identity across configured root and nested searches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "splice-nested-metadata-"));
  const nested = join(directory, "Pack");
  const library = new BrowserMetadataLibrary({ path: join(directory, "metadata.sqlite") });
  const service = new ToolService({ browserMetadata: library, spliceRoots: [directory] });
  try {
    await mkdir(nested);
    await writeFile(join(nested, "Kick.wav"), "audio");
    const rootItem = { root: "local_splice", path: [directory, "Pack/Kick.wav"] };
    const plan = await service.call("set_browser_item_metadata", {
      ...rootItem, expectedMetadataRevision: 0, favorite: true, tags: ["drums"],
    });
    await service.call("set_browser_item_metadata", {
      ...rootItem, expectedMetadataRevision: 0, favorite: true, tags: ["drums"],
      dryRun: false, confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash,
    });
    const nestedItem = await service.call("get_browser_item_metadata", {
      root: "local_splice", path: [nested, "Kick.wav"],
    });
    assert.deepEqual(nestedItem.metadata, { favorite: true, tags: ["drums"], revision: 1 });
    assert.deepEqual(nestedItem.item.path, [await realpath(directory), "Pack/Kick.wav"]);
    const search = await service.call("search_local_splice_samples", {
      rootPath: nested, query: "kick", includeMetadata: true,
    });
    assert.deepEqual(search.samples[0].metadata, { favorite: true, tags: ["drums"], revision: 1 });
  } finally { library.close(); await rm(directory, { recursive: true, force: true }); }
});

test("private tags and favorites bind to an observed local audio sample without Live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-sample-metadata-"));
  const library = new BrowserMetadataLibrary({ path: join(directory, "metadata.sqlite") });
  const sample = join(directory, "kick.wav");
  const outside = await mkdtemp(join(tmpdir(), "local-sample-outside-"));
  const service = new ToolService({ browserMetadata: library });
  const target = { root: "local_splice", path: [directory, "kick.wav"] };
  try {
    await writeFile(sample, "audio");
    await writeFile(join(outside, "external.wav"), "audio");
    await symlink(join(outside, "external.wav"), join(directory, "linked.wav"));
    const before = await service.call("get_browser_item_metadata", target);
    assert.equal(before.item.uri, await realpath(sample));
    assert.deepEqual(before.metadata, { favorite: false, tags: [], revision: 0 });
    const args = { ...target, expectedMetadataRevision: 0, favorite: true, tags: ["Kick", "Drums"] };
    const dry = await service.call("set_browser_item_metadata", args);
    await rm(sample);
    await writeFile(sample, "replacement audio");
    await assert.rejects(() => service.call("set_browser_item_metadata", { ...args, dryRun: false,
      confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash }), /plan hash|confirmation/);
    const fresh = await service.call("set_browser_item_metadata", args);
    const applied = await service.call("set_browser_item_metadata", { ...args, dryRun: false,
      confirmationToken: fresh.confirmation.token, planHash: fresh.confirmation.planHash });
    assert.deepEqual(applied.observed, { favorite: true, tags: ["drums", "kick"], revision: 1 });
    assert.equal((await service.call("search_browser_item_metadata", { root: "local_splice", favorite: true, tags: ["kick"] })).items.length, 1);
    await assert.rejects(() => service.call("get_browser_item_metadata", { root: "local_splice",
      path: [directory, "../external.wav"] }), /relative|path|segment/);
    await assert.rejects(() => service.call("get_browser_item_metadata", { root: "local_splice",
      path: [directory, "linked.wav"] }), /symlink/);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
