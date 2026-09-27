import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";

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

test("local Splice search finds samples by pack folder name", async () => {
  const root = await mkdtemp(join(tmpdir(), "splice-pack-search-"));
  try {
    await mkdir(join(root, "House Essentials"));
    await mkdir(join(root, "Trap Essentials"));
    await writeFile(join(root, "House Essentials", "Kick.wav"), "audio");
    await writeFile(join(root, "House Essentials", "Hat.wav"), "audio");
    await writeFile(join(root, "Trap Essentials", "Kick.wav"), "audio");
    const result = await new ToolService({}).call("search_local_splice_samples", {
      rootPath: root, query: "house essentials", maxDepth: 2, limit: 10,
    });
    assert.deepEqual(result.samples.map(sample => sample.relativePath),
      ["House Essentials/Hat.wav", "House Essentials/Kick.wav"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured local Splice roots report canonical available and missing folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "splice-root-"));
  try {
    const service = new ToolService({ spliceRoots: [root, join(root, "missing")] });
    const result = await service.call("list_local_splice_roots", {});
    assert.equal(result.roots[0].available, true);
    assert.equal(result.roots[0].rootPath, await (await import("node:fs/promises")).realpath(root));
    assert.equal(result.roots[1].available, false);
    assert.equal(result.roots[1].rootPath, null);
    assert.equal(result.scope, "configured_local_directories");
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

test("local Splice search pages in stable relative-path order across files and folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "splice-search-"));
  try {
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "hit.wav"), "audio");
    await writeFile(join(root, "a-hit.wav"), "audio");
    await writeFile(join(root, "b-hit.wav"), "audio");
    const service = new ToolService({});
    const args = { rootPath: root, query: "hit", maxDepth: 2, limit: 1 };
    const first = await service.call("search_local_splice_samples", { ...args, offset: 0 });
    assert.deepEqual(first.samples.map(({ relativePath }) => relativePath), ["a-hit.wav"]);
    assert.equal(first.nextOffset, 1);
    const second = await service.call("search_local_splice_samples", { ...args, offset: first.nextOffset });
    assert.deepEqual(second.samples.map(({ relativePath }) => relativePath), ["a/hit.wav"]);
    assert.equal(second.nextOffset, 2);
    const third = await service.call("search_local_splice_samples", { ...args, offset: second.nextOffset });
    assert.deepEqual(third.samples.map(({ relativePath }) => relativePath), ["b-hit.wav"]);
    assert.equal(third.nextOffset, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local Splice search reports an incomplete scan at its visited-item limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "splice-bounded-"));
  try {
    await writeFile(join(root, "a.wav"), "audio");
    await writeFile(join(root, "b.wav"), "audio");
    await writeFile(join(root, "c.wav"), "audio");
    const service = new ToolService({});
    const bounded = await service.call("search_local_splice_samples", {
      rootPath: root, query: "c", maxVisited: 2,
    });
    assert.deepEqual(bounded.samples, []);
    assert.equal(bounded.visited, 2);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.nextOffset, null);
    const complete = await service.call("search_local_splice_samples", {
      rootPath: root, query: "c", maxVisited: 3,
    });
    assert.deepEqual(complete.samples.map(sample => sample.relativePath), ["c.wav"]);
    assert.equal(complete.truncated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP accepts the scan limit and returns explicit truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "splice-mcp-bounded-"));
  try {
    await writeFile(join(root, "a.wav"), "audio");
    await writeFile(join(root, "b.wav"), "audio");
    const response = await createRouter(new ToolService({}))({
      id: 1, method: "tools/call", params: {
        name: "search_local_splice_samples", arguments: { rootPath: root, query: "b", maxVisited: 1 },
      },
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.structuredContent.truncated, true);
    assert.equal(response.result.structuredContent.visited, 1);
    assert.deepEqual(response.result.structuredContent.samples, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
