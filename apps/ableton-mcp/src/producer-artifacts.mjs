import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_BYTES = 2_000_000;
const digest = text => createHash("sha256").update(text).digest("hex");

export class ProducerArtifacts {
  constructor(directory) { this.directory = resolve(directory); }

  #project(projectId) {
    if (typeof projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(projectId))
      throw new Error("projectId must contain 1–80 letters, digits, underscores or hyphens");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.directory);
    const directory = join(root, projectId);
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("artifact project directory cannot be a symlink");
    return directory;
  }

  put(projectId, kind, value) {
    const text = JSON.stringify({ format: "ableton-producer-artifact-v1", projectId, kind, value });
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("artifact byte limit exceeded");
    const artifactId = digest(text);
    const path = join(this.#project(projectId), `${artifactId}.json`);
    const pending = `${path}.${randomUUID()}.pending`;
    writeFileSync(pending, text, { flag: "wx", mode: 0o600 });
    try { linkSync(pending, path); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      this.get(projectId, artifactId);
    } finally { unlinkSync(pending); }
    return artifactId;
  }

  get(projectId, artifactId) {
    if (typeof artifactId !== "string" || !/^[a-f0-9]{64}$/.test(artifactId)) throw new Error("invalid artifactId");
    let fd;
    try {
      fd = openSync(join(this.#project(projectId), `${artifactId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error("artifact size limit exceeded");
      const text = readFileSync(fd, "utf8");
      if (digest(text) !== artifactId) throw new Error("artifact integrity check failed");
      const record = JSON.parse(text);
      if (record.projectId !== projectId || record.format !== "ableton-producer-artifact-v1") throw new Error("artifact integrity check failed");
      return record;
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("artifact not found in project");
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  page(projectId, artifactId, offset = 0, limit = 4000) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 8000) throw new Error("limit must be between 1 and 8000 characters");
    const text = JSON.stringify(this.get(projectId, artifactId));
    const end = Math.min(offset + limit, text.length);
    return { artifactId, text: text.slice(offset, end), offset, totalCharacters: text.length,
      truncated: end < text.length, nextOffset: end < text.length ? end : null };
  }
}
