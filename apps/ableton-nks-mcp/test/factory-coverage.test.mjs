import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";

test("factory coverage separates observed loadability from name-matched knowledge", async () => {
  const reads = [];
  const service = new ToolService({ bridge: { async request(method, args) {
    assert.equal(method, "get_factory_browser_items"); reads.push(args.root);
    return { stateVersion: 4, root: args.root, path: [], children: args.root === "audio_effects" ? [
      { name: "Utility", uri: "utility", loadable: true }, { name: "Roar", uri: "roar", loadable: true },
      { name: "Folder", uri: "folder", loadable: false } ] : [] };
  } } });
  const result = await service.call("get_factory_coverage", {});
  assert.equal(reads.length, 3);
  assert.equal(result.deepIntegrationVerified, false);
  assert.equal(result.roots.audio_effects.profiledByName[0].profileId, "utility");
  assert.equal(result.roots.audio_effects.missingProfiles[0].name, "Roar");
  assert.equal(result.roots.audio_effects.loadableCount, 2);
});
