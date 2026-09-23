import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, SOURCE_REL, listFilesRecursive, navigationPaths } from "./lib.mjs";
import { toolContracts } from "../../apps/ableton-mcp/src/tool-contracts.mjs";
import { TOOLS_REFERENCE_PATH, renderToolsReference } from "./tools-reference.mjs";

const pagesRoot = path.join(REPO_ROOT, SOURCE_REL, "pages");

test("the tools reference matches the published tool contracts", async () => {
  assert.equal(await readFile(TOOLS_REFERENCE_PATH, "utf8"), renderToolsReference(),
    "run node scripts/docs/tools-reference.mjs");
});

test("navigation lists every page exactly once", async () => {
  const navigation = JSON.parse(await readFile(path.join(REPO_ROOT, SOURCE_REL, "navigation.json"), "utf8"));
  assert.deepEqual(navigationPaths(navigation).sort(), await listFilesRecursive(pagesRoot));
});

test("relative links between pages resolve to existing pages", async () => {
  const pages = await listFilesRecursive(pagesRoot);
  const broken = [];
  for (const page of pages) {
    const text = await readFile(path.join(pagesRoot, page), "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/gu)) {
      if (/^[a-z]+:/u.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), target));
      if (!pages.includes(resolved)) broken.push(`${page} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("the README tool count matches the published contracts", async () => {
  const readme = await readFile(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, new RegExp(`publishes ${Object.keys(toolContracts).length} tools`, "u"));
});

test("README links to repository files resolve", async () => {
  const readme = await readFile(path.join(REPO_ROOT, "README.md"), "utf8");
  const { existsSync } = await import("node:fs");
  const broken = [...readme.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/gu)].map(([, target]) => target)
    .filter((target) => !/^[a-z]+:/u.test(target) && !existsSync(path.join(REPO_ROOT, target)));
  assert.deepEqual(broken, []);
});
