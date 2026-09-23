import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, extname, sep } from "node:path";

const AUDIO_EXTENSIONS = new Set([".aif", ".aiff", ".flac", ".mp3", ".ogg", ".wav"]);
const compareNames = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export async function searchLocalSpliceSamples({ rootPath, query, maxDepth = 8, limit = 100 }) {
  if (typeof rootPath !== "string" || !isAbsolute(rootPath)) throw new Error("rootPath must be absolute");
  if (typeof query !== "string" || !query.trim()) throw new Error("query must be non-empty");
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 16) throw new Error("maxDepth must be 1 through 16");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1 through 200");
  const root = await realpath(rootPath);
  if (!(await stat(root)).isDirectory()) throw new Error("rootPath must be a directory");
  const needle = query.trim().toLocaleLowerCase();
  const samples = [];

  async function visit(directory, depth) {
    if (depth > maxDepth || samples.length >= limit) return;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      if (samples.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await visit(candidate, depth + 1);
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())
          && entry.name.toLocaleLowerCase().includes(needle)) {
        const sourcePath = await realpath(candidate);
        const childPath = relative(root, sourcePath);
        if (childPath.startsWith(`..${sep}`) || childPath === ".." || isAbsolute(childPath)) continue;
        samples.push({ relativePath: childPath.split(sep).join("/"), sourcePath });
      }
    }
  }

  await visit(root, 1);
  samples.sort((left, right) => compareNames(left.relativePath, right.relativePath));
  return { rootPath: root, query: query.trim(), scope: "local_files_only", samples,
    limitation: "Searches downloaded local audio files only; not Splice cloud catalog, downloads, or sync." };
}
