import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../../../", import.meta.url);

function version(value) {
  return value.split(".").map(Number);
}

function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] ?? 0) !== minimum[index]) return (actual[index] ?? 0) > minimum[index];
  }
  return true;
}

async function sources(path) {
  const entries = await readdir(new URL(path, root), { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs")).map((entry) => join(entry.parentPath, entry.name));
}

test("engines floor covers unflagged node:sqlite when a packed module imports it", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const packed = [];
  for (const entry of pkg.files) {
    if ((await stat(new URL(entry, root))).isDirectory()) packed.push(...await sources(entry));
    else if (entry.endsWith(".mjs")) packed.push(new URL(entry, root).pathname);
  }
  const usesSqlite = (await Promise.all(packed.map((path) => readFile(path, "utf8")))).some((text) => text.includes("\"node:sqlite\""));
  assert.equal(usesSqlite, true);
  const floor = pkg.engines.node.match(/^>=(\d+(?:\.\d+){0,2})$/)?.[1];
  assert.ok(floor, `unexpected engines.node ${pkg.engines.node}`);
  assert.ok(atLeast(version(floor), [22, 13, 0]), `node:sqlite needs --experimental-sqlite below 22.13.0; engines.node is ${pkg.engines.node}`);
});
