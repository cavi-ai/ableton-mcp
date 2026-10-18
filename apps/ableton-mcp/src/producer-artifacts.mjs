import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
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

  #sessionId(sessionId) {
    if (typeof sessionId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId)) throw new Error("invalid sessionId");
    return sessionId;
  }

  createSession(projectId, value) {
    return this.#sessionRevision(projectId, randomUUID(), 1, value);
  }

  session(projectId, sessionId) {
    this.#sessionId(sessionId);
    const prefix = `session-${sessionId}-`;
    const revisions = readdirSync(this.#project(projectId)).filter(name => name.startsWith(prefix) && /^\d+\.json$/.test(name.slice(prefix.length)))
      .map(name => Number(name.slice(prefix.length, -5)));
    if (!revisions.length) throw new Error("session not found in project");
    const revision = revisions.reduce((highest, item) => Math.max(highest, item), 0);
    const path = join(this.#project(projectId), `${prefix}${revision}.json`);
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error("invalid session revision");
      const sessionRef = digest(readFileSync(fd, "utf8"));
      const record = this.get(projectId, sessionRef);
      if (record.kind !== "session" || record.value.sessionId !== sessionId || record.value.revision !== revision) throw new Error("session integrity check failed");
      return { sessionId, sessionRef, value: record.value };
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  advanceSession(projectId, sessionId, expectedRevision, value) {
    const current = this.session(projectId, sessionId);
    if (current.value.revision !== expectedRevision) throw new Error("session revision conflict; read the current session");
    return this.#sessionRevision(projectId, sessionId, expectedRevision + 1, { ...value, previousRef: current.sessionRef });
  }

  #sessionRevision(projectId, sessionId, revision, value) {
    const saved = { ...value, sessionId, revision, updatedAt: new Date().toISOString() };
    const sessionRef = this.put(projectId, "session", saved);
    const directory = this.#project(projectId);
    try { linkSync(join(directory, `${sessionRef}.json`), join(directory, `session-${sessionId}-${revision}.json`)); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("session revision conflict; read the current session");
      throw error;
    }
    return { sessionId, sessionRef, value: saved };
  }

  sessions(projectId, offset = 0) {
    const ids = [...new Set(readdirSync(this.#project(projectId)).map(name => /^session-([a-f0-9-]{36})-\d+\.json$/.exec(name)?.[1]).filter(Boolean))].sort();
    return { sessions: ids.slice(offset, offset + 20).map(sessionId => {
      const { value, sessionRef } = this.session(projectId, sessionId);
      return { sessionId, sessionRef, revision: value.revision, phase: value.phase, goal: value.goal.slice(0, 200) };
    }), nextOffset: offset + 20 < ids.length ? offset + 20 : null };
  }
}
