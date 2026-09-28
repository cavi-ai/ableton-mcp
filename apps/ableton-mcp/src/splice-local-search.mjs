import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, extname, sep } from "node:path";

const AUDIO_EXTENSIONS = new Set([".aif", ".aiff", ".flac", ".mp3", ".ogg", ".wav"]);
const compareNames = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export async function listConfiguredSpliceRoots(paths) {
  const roots = [];
  for (const configuredPath of paths) {
    try {
      const rootPath = await realpath(configuredPath);
      const available = (await stat(rootPath)).isDirectory();
      roots.push({ configuredPath, rootPath: available ? rootPath : null, available });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      roots.push({ configuredPath, rootPath: null, available: false });
    }
  }
  return { roots, scope: "configured_local_directories",
    limitation: "Existing local Splice folders and cache files only; does not search cloud assets, verify licenses, or synchronize downloads." };
}

export async function browseLocalSpliceDirectory({ rootPath, offset = 0, limit = 100 }, configuredRoots = []) {
  if (typeof rootPath !== "string" || !isAbsolute(rootPath)) throw new Error("rootPath must be absolute");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative safe integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1 through 200");
  const root = await realpath(rootPath);
  if (!(await stat(root)).isDirectory()) throw new Error("rootPath must be a directory");
  const configured = await listConfiguredSpliceRoots(configuredRoots);
  if (!configured.roots.some(item => item.available &&
      (root === item.rootPath || root.startsWith(`${item.rootPath}${sep}`))))
    throw new Error("rootPath must be inside a configured Splice root");
  const all = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() || (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())))
    .sort((left, right) => compareNames(left.name, right.name));
  const entries = all.slice(offset, offset + limit).map(entry => ({
    name: entry.name, type: entry.isDirectory() ? "directory" : "audio_file", sourcePath: join(root, entry.name),
  }));
  return { rootPath: root, scope: "local_files_only", offset, total: all.length,
    nextOffset: offset + limit < all.length ? offset + limit : null, entries };
}

export async function observeLocalSpliceSample(rootPath, relativePath) {
  if (typeof rootPath !== "string" || !isAbsolute(rootPath)) throw new Error("rootPath must be absolute");
  if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath) ||
      relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("relativePath must contain ordinary relative path segments");
  if (!AUDIO_EXTENSIONS.has(extname(relativePath).toLowerCase())) throw new Error("local sample must be an audio file");
  const root = await realpath(rootPath);
  if (!(await stat(root)).isDirectory()) throw new Error("rootPath must be a directory");
  let candidate = root;
  for (const part of relativePath.split("/")) {
    candidate = join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error("local sample path must not contain a symlink");
  }
  const sourcePath = await realpath(candidate);
  const actualRelativePath = relative(root, sourcePath);
  if (!actualRelativePath || actualRelativePath === ".." || actualRelativePath.startsWith(`..${sep}`) || isAbsolute(actualRelativePath))
    throw new Error("local sample must remain inside rootPath");
  const info = await stat(sourcePath);
  if (!info.isFile()) throw new Error("local sample must be a file");
  return { root: "local_splice", path: [root, actualRelativePath.split(sep).join("/")], uri: sourcePath,
    sourceIdentity: { size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino } };
}

export async function searchLocalSpliceSamples({ rootPath, query, maxDepth = 8, offset = 0, limit = 100,
  maxVisited = 50000, matchSample }) {
  if (typeof rootPath !== "string" || !isAbsolute(rootPath)) throw new Error("rootPath must be absolute");
  if (query !== undefined && (typeof query !== "string" || !query.trim())) throw new Error("query must be non-empty");
  if (query === undefined && !matchSample) throw new Error("query or metadata filter is required");
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 16) throw new Error("maxDepth must be 1 through 16");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative safe integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1 through 200");
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 50000)
    throw new Error("maxVisited must be 1 through 50000");
  const root = await realpath(rootPath);
  if (!(await stat(root)).isDirectory()) throw new Error("rootPath must be a directory");
  const needle = query?.trim().toLocaleLowerCase();
  const samples = [];
  let matched = 0;
  let visited = 0;
  let truncated = false;

  async function visit(directory, depth) {
    if (depth > maxDepth || matched > offset + limit || truncated) return;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareNames(
        left.isDirectory() ? `${left.name}/` : left.name,
        right.isDirectory() ? `${right.name}/` : right.name));
    for (const entry of entries) {
      if (matched > offset + limit) break;
      if (visited >= maxVisited) { truncated = true; break; }
      visited++;
      if (entry.isSymbolicLink()) continue;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await visit(candidate, depth + 1);
        if (truncated) break;
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const relativeCandidate = relative(root, candidate);
        if (needle && !relativeCandidate.toLocaleLowerCase().includes(needle)) continue;
        const sourcePath = await realpath(candidate);
        const childPath = relative(root, sourcePath);
        if (childPath.startsWith(`..${sep}`) || childPath === ".." || isAbsolute(childPath)) continue;
        if (matchSample && !await matchSample({ rootPath: root, relativePath: childPath.split(sep).join("/"), sourcePath })) continue;
        if (matched >= offset && samples.length < limit)
          samples.push({ relativePath: childPath.split(sep).join("/"), sourcePath });
        matched++;
      }
    }
  }

  await visit(root, 1);
  samples.sort((left, right) => compareNames(left.relativePath, right.relativePath));
  return { rootPath: root, query: query?.trim() ?? null, scope: "local_files_only", offset,
    visited, maxVisited, truncated,
    nextOffset: matched > offset + limit ? offset + limit : null, samples,
    limitation: "Searches local audio and cache files only; not Splice cloud catalog, license verification, downloads, or sync." };
}
