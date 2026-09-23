import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";

test("factory coverage separates observed loadability from name-matched knowledge", async () => {
  const reads = [];
  const service = new ToolService({ bridge: { async request(method, args) {
    assert.equal(method, "get_factory_browser_items"); reads.push(args.root);
    return { stateVersion: 4, root: args.root, path: [], children: args.root === "audio_effects" ? [
      { name: "Utility", uri: "utility", loadable: true }, { name: "Roar", uri: "roar", loadable: true },
      { name: "Unknown FX", uri: "unknown", loadable: true },
      { name: "Folder", uri: "folder", loadable: false } ] : [] };
  } } });
  const result = await service.call("get_factory_coverage", {});
  assert.equal(reads.length, 3);
  assert.equal(result.deepIntegrationVerified, false);
  assert.equal(result.roots.audio_effects.profiledByName[0].profileId, "utility");
  assert.equal(result.roots.audio_effects.profiledByName[1].profileId, "roar");
  assert.equal(result.roots.audio_effects.missingProfiles[0].name, "Unknown FX");
  assert.equal(result.roots.audio_effects.loadableCount, 3);
});

test("factory coverage reads every page of a large factory root", async () => {
  const calls = [];
  const service = new ToolService({ bridge: { async request(method, args) {
    assert.equal(method, "get_factory_browser_items");
    calls.push({ root: args.root, offset: args.offset, limit: args.limit });
    const totalChildren = args.root === "instruments" ? 205 : 0;
    const start = args.offset ?? 0;
    const end = Math.min(start + (args.limit ?? totalChildren), totalChildren);
    return { stateVersion: 7, root: args.root, path: [], totalChildren,
      nextOffset: end < totalChildren ? end : null,
      children: Array.from({ length: end - start }, (_, index) => ({
        name: `Unprofiled ${start + index}`, uri: `factory:${start + index}`, loadable: true
      })) };
  } } });
  const result = await service.call("get_factory_coverage", {});
  assert.equal(result.roots.instruments.loadableCount, 205);
  assert.equal(result.roots.instruments.missingProfiles.at(-1).uri, "factory:204");
  assert.deepEqual(calls.filter(call => call.root === "instruments").map(call => call.offset), [0, 200]);
});

test("factory coverage rejects a truncated factory page", async () => {
  const service = new ToolService({ bridge: { async request(method, args) {
    assert.equal(method, "get_factory_browser_items");
    return { root: args.root, path: [], stateVersion: 2, totalChildren: 3,
      nextOffset: null, children: [{ name: "One", uri: "one", loadable: true }] };
  } } });
  await assert.rejects(service.call("get_factory_coverage", {}), /incomplete factory browser pagination/);
});
