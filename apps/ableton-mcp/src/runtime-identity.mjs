import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Measure the same packaged code in a checkout and an installed npm artifact.
// Documentation and absolute paths do not contribute to the runtime identity.
export function createRuntimeIdentity(directory) {
  const manifest = readFileSync(join(directory, "package.json"));
  const pkg = JSON.parse(manifest);
  const files = new Set(["package.json"]);
  const visit = path => {
    const info = lstatSync(join(directory, path));
    if (info.isSymbolicLink()) throw new Error(`runtime package path is a symlink: ${path}`);
    if (info.isDirectory()) for (const name of readdirSync(join(directory, path)).sort()) visit(`${path}/${name}`);
    else if (info.isFile()) files.add(path);
    else throw new Error(`runtime package path is not a regular file: ${path}`);
  };
  for (const path of pkg.files || []) {
    if (typeof path !== "string" || path.includes("\\") || path.startsWith("/") || posix.normalize(path) !== path || path.split("/").includes(".."))
      throw new Error("invalid runtime package path");
    if (/^(apps|packages|ableton)\//.test(path)) visit(path);
  }
  const hash = createHash("sha256");
  for (const path of [...files].sort()) {
    const bytes = path === "package.json" ? manifest : readFileSync(join(directory, path));
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`); hash.update(bytes);
  }
  return { schemaVersion: 1, name: pkg.name, version: pkg.version, sourceSha256: hash.digest("hex"), fileCount: files.size };
}

let identity;
export const runtimeIdentity = () => ({ ...(identity ??= createRuntimeIdentity(root)) });
export const withRuntimeIdentity = (name, value) => name === "get_live_state" ? { ...value, serverIdentity: runtimeIdentity() } : value;
