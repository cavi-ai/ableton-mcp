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
  if (end < 0) return [];
  let bodyStart = end + marker.length;
  while (bytes[bodyStart] === 10 || bytes[bodyStart] === 13) bodyStart += 1;
  const header = bytes.subarray(0, end + marker.length).toString("utf8");
  return [...header.matchAll(/<FILE\s+name="([^"]+\.prt_omn)"\s+offset="(\d+)"\s+size="(\d+)"\s*\/>/g)]
    .map((match) => ({
      name: decodeXml(match[1]),
      offset: Number(match[2]),
      size: Number(match[3]),
      bodyStart
    }));
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
      for (const patch of embeddedPatches(bytes)) {
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
          sourcePath: join(databasePath, patch.name),
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
