import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { validateAdapterDiscovery } from "./adapter-contract.mjs";

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function embeddedPatches(bytes) {
  const marker = Buffer.from("</FileSystem>");
  const end = bytes.indexOf(marker);
  if (end < 0) {
    if (bytes.includes(Buffer.from("<FileSystem"))) throw new Error("truncated embedded Omnisphere index");
    return [];
  }
  let bodyStart = end + marker.length;
  while (bytes[bodyStart] === 10 || bytes[bodyStart] === 13) bodyStart += 1;
  const header = bytes.subarray(0, end + marker.length).toString("utf8");
  const folders = [];
  const patches = [];
  const attribute = (tag, key) => {
    const match = tag.match(new RegExp(`(?:\\s)${key}="([^"]*)"`));
    return match?.[1];
  };
  for (const match of header.matchAll(/<\/DIR\s*>|<DIR\b[^>]*>|<FILE\b[^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith("</DIR")) {
      if (!folders.length) throw new Error("unbalanced embedded Omnisphere directory");
      folders.pop();
      continue;
    }
    if (tag.startsWith("<DIR")) {
      const folder = decodeXml(attribute(tag, "name") ?? "");
      if (!folder || folder === "." || folder === ".." || folder.includes("/") || folder.includes("\\"))
        throw new Error("invalid embedded Omnisphere directory");
      folders.push(folder);
      continue;
    }
    if (!tag.endsWith("/>")) throw new Error("malformed embedded Omnisphere patch entry");
    const entry = decodeXml(attribute(tag, "name") ?? "");
    if (!entry.toLowerCase().endsWith(".prt_omn")) continue;
    const parts = entry.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\")))
      throw new Error("invalid embedded Omnisphere patch path");
    const offsetText = attribute(tag, "offset");
    const sizeText = attribute(tag, "size");
    if (!/^\d+$/.test(offsetText ?? "") || !/^\d+$/.test(sizeText ?? ""))
      throw new Error("invalid embedded patch extent");
    patches.push({ name: [...folders, ...parts].join("/"),
      offset: Number(offsetText), size: Number(sizeText), bodyStart });
  }
  if (folders.length) throw new Error("unbalanced embedded Omnisphere directory");
  return patches;
}

export async function discoverOmnisphereFactoryPresets(config) {
  if (!config.enabled) return [];
  const discoveries = [];
  for (const root of config.factoryRoots) {
    const files = await readdir(root, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile() || !config.extensions.includes(extname(entry.name).toLowerCase())) continue;
      const databasePath = join(root, entry.name);
      const bytes = await readFile(databasePath);
      const patches = embeddedPatches(bytes);
      const basenameCounts = new Map();
      for (const patch of patches) {
        const name = basename(patch.name);
        basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
      }
      for (const patch of patches) {
        const bodyLength = bytes.length - patch.bodyStart;
        if (!Number.isSafeInteger(patch.offset) || !Number.isSafeInteger(patch.size) ||
            patch.offset < 0 || patch.size <= 0 || patch.offset > bodyLength || patch.size > bodyLength - patch.offset) {
          throw new Error(`invalid embedded patch extent in ${databasePath}: ${patch.name}`);
        }
        const payload = bytes.subarray(patch.bodyStart + patch.offset, patch.bodyStart + patch.offset + patch.size);
        const category = dirname(patch.name) === "." ? "Factory" : dirname(patch.name);
        discoveries.push(validateAdapterDiscovery({
          productSlug: config.productSlug,
          sourceRoot: root,
          // Preserve existing IDs where a basename is unique; disambiguate real collisions by full entry path.
          sourcePath: join(databasePath, basenameCounts.get(basename(patch.name)) === 1
            ? basename(patch.name) : patch.name),
          sourceContainerPath: databasePath,
          sourceEntryName: patch.name,
          name: basename(patch.name, ".prt_omn"),
          bank: basename(databasePath, ".db"),
          subBank: category,
          types: [category],
          modes: [],
          author: config.vendor,
          sourceFingerprint: `sha256:${createHash("sha256").update(payload).digest("hex")}`
        }));
      }
    }
  }
  return discoveries.sort((left, right) =>
    left.sourceEntryName.localeCompare(right.sourceEntryName) || left.bank.localeCompare(right.bank)
  );
}
