import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function itemKey(item) {
  if (typeof item?.root !== "string" || !item.root || !Array.isArray(item.path) ||
      item.path.length === 0 || item.path.some(part => typeof part !== "string" || !part) ||
      typeof item.uri !== "string" || !item.uri) throw new Error("exact browser item identity is required");
  return JSON.stringify([item.root, item.path, item.uri]);
}

function normalizedTags(tags) {
  if (!Array.isArray(tags) || tags.length > 32) throw new Error("tags must be an array of at most 32 entries");
  const result = tags.map(tag => {
    if (typeof tag !== "string" || !tag.trim() || tag.trim().length > 80) throw new Error("tags must contain non-empty strings of at most 80 characters");
    return tag.trim().toLowerCase();
  });
  return [...new Set(result)].sort();
}

export class BrowserMetadataLibrary {
  constructor({ path }) {
    if (typeof path !== "string" || !path) throw new Error("browser metadata path is required");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("browser metadata path must be an ordinary file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS browser_metadata (
        item_key TEXT PRIMARY KEY, root TEXT NOT NULL, path_json TEXT NOT NULL, uri TEXT NOT NULL,
        favorite INTEGER NOT NULL CHECK(favorite IN (0, 1)), tags_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0)
      );
      CREATE INDEX IF NOT EXISTS browser_metadata_root ON browser_metadata(root);`);
  }

  get(item) {
    const row = this.database.prepare("SELECT favorite, tags_json, revision FROM browser_metadata WHERE item_key = ?").get(itemKey(item));
    return row ? { favorite: Boolean(row.favorite), tags: JSON.parse(row.tags_json), revision: row.revision } :
      { favorite: false, tags: [], revision: 0 };
  }

  plan(item, expectedRevision, changes) {
    itemKey(item);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("expectedMetadataRevision must be a non-negative integer");
    if (changes.favorite === undefined && changes.tags === undefined) throw new Error("favorite or tags is required");
    if (changes.favorite !== undefined && typeof changes.favorite !== "boolean") throw new Error("favorite must be boolean");
    const before = this.get(item);
    if (before.revision !== expectedRevision) throw new Error(`metadata revision mismatch: expected ${expectedRevision}, observed ${before.revision}`);
    return { before, after: { favorite: changes.favorite ?? before.favorite,
      tags: changes.tags === undefined ? before.tags : normalizedTags(changes.tags), revision: before.revision + 1 } };
  }

  set(item, expectedRevision, changes) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const { after } = this.plan(item, expectedRevision, changes);
      this.database.prepare(`INSERT INTO browser_metadata (item_key, root, path_json, uri, favorite, tags_json, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_key) DO UPDATE SET favorite=excluded.favorite, tags_json=excluded.tags_json, revision=excluded.revision`)
        .run(itemKey(item), item.root, JSON.stringify(item.path), item.uri, after.favorite ? 1 : 0, JSON.stringify(after.tags), after.revision);
      this.database.exec("COMMIT");
      return after;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  search({ root, favorite, tags, limit = 50 } = {}) {
    if (root !== undefined && (typeof root !== "string" || !root)) throw new Error("root must be a non-empty string");
    if (favorite !== undefined && typeof favorite !== "boolean") throw new Error("favorite must be boolean");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be from 1 to 200");
    const requiredTags = tags === undefined ? [] : normalizedTags(tags);
    const where = [];
    const values = [];
    if (root !== undefined) { where.push("root = ?"); values.push(root); }
    if (favorite !== undefined) { where.push("favorite = ?"); values.push(favorite ? 1 : 0); }
    for (const tag of requiredTags) {
      where.push("EXISTS (SELECT 1 FROM json_each(tags_json) WHERE json_each.value = ?)");
      values.push(tag);
    }
    const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.database.prepare(`SELECT root, path_json, uri, favorite, tags_json, revision FROM browser_metadata
      ${predicate} ORDER BY root, path_json LIMIT ?`).all(...values, limit)
      .map(row => ({ root: row.root, path: JSON.parse(row.path_json), uri: row.uri,
        metadata: { favorite: Boolean(row.favorite), tags: JSON.parse(row.tags_json), revision: row.revision }, liveVerified: false }));
  }

  close() { this.database.close(); }
}
