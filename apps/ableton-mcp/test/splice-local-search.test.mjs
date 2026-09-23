import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolService } from "../src/tool-service.mjs";

test("local Splice search finds only audio assets under the selected root", async () => {
  const root = await mkdtemp(join(tmpdir(), "splice-search-"));
  try {
    await mkdir(join(root, "kits"));
    await writeFile(join(root, "kits", "Snare One.wav"), "audio");
    await writeFile(join(root, "kits", "Snare metadata.json"), "metadata");
    await writeFile(join(root, "Snare Two.aif"), "audio");
    const result = await new ToolService({}).call("search_local_splice_samples", {
      rootPath: root, query: "snare", maxDepth: 2, limit: 10,
    });
    assert.deepEqual(result.samples.map(sample => sample.relativePath), ["Snare Two.aif", "kits/Snare One.wav"]);
    assert.equal(result.samples.every(sample => sample.sourcePath.startsWith(`${result.rootPath}/`)), true);
    assert.equal(result.scope, "local_files_only");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local Splice search never follows symlinks outside the selected root", async () => {
  const root = await mkdtemp(join(tmpdir(), "splice-search-"));
  const outside = await mkdtemp(join(tmpdir(), "splice-outside-"));
  try {
    await writeFile(join(outside, "Snare Outside.wav"), "audio");
    await symlink(outside, join(root, "linked"));
    const result = await new ToolService({}).call("search_local_splice_samples", {
      rootPath: root, query: "snare", maxDepth: 2, limit: 10,
    });
    assert.deepEqual(result.samples, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
