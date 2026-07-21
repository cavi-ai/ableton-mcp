import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { validateAdapterDiscovery } from "./adapter-contract.mjs";

async function walk(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && entry.name.toLowerCase() === "user") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(root, path)));
    else output.push(path);
  }
  return output;
}

export async function discoverSerumFactoryPresets(config) {
  if (!config.enabled) return [];
  const discoveries = [];
  for (const root of config.factoryRoots) {
    for (const sourcePath of await walk(root)) {
      if (!config.extensions.includes(extname(sourcePath).toLowerCase())) continue;
      const bytes = await readFile(sourcePath);
      const category = basename(dirname(sourcePath));
      discoveries.push(
        validateAdapterDiscovery({
          productSlug: config.productSlug,
          sourceRoot: root,
          sourcePath,
          name: basename(sourcePath, extname(sourcePath)),
          bank: "Factory",
          subBank: category,
          types: [category],
          modes: [],
          author: config.vendor,
          sourceFingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
        })
      );
    }
  }
  return discoveries.sort((a, b) =>
    relative(a.sourceRoot, a.sourcePath).localeCompare(relative(b.sourceRoot, b.sourcePath))
  );
}
