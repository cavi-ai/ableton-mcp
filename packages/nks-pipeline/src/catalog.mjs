import { DatabaseSync } from "node:sqlite";

function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new Error("tags must be an array");
  const normalized = tags.map((tag) => {
    if (typeof tag !== "string" || !tag.trim()) throw new Error("tags must contain non-empty strings");
    return tag.trim().toLowerCase();
  });
  return [...new Set(normalized)].sort();
}

export class Catalog {
  static open(path) {
    return new Catalog(new DatabaseSync(path));
  }

  constructor(database) {
    this.database = database;
    database.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      product_slug TEXT NOT NULL,
      name TEXT NOT NULL,
      bank TEXT NOT NULL,
      sub_bank TEXT NOT NULL,
      author TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS presets_product_name ON presets(product_slug, name);
    CREATE TABLE IF NOT EXISTS artwork (
      id TEXT PRIMARY KEY,
      product_slug TEXT NOT NULL,
      category TEXT NOT NULL,
      state TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS preset_artwork (
      preset_id TEXT PRIMARY KEY REFERENCES presets(id) ON DELETE CASCADE,
      artwork_id TEXT NOT NULL REFERENCES artwork(id)
    );
    CREATE TABLE IF NOT EXISTS preset_metadata (
      preset_id TEXT PRIMARY KEY REFERENCES presets(id) ON DELETE CASCADE,
      favorite INTEGER NOT NULL CHECK(favorite IN (0, 1)),
      revision INTEGER NOT NULL CHECK(revision > 0)
    );
    CREATE TABLE IF NOT EXISTS preset_tags (
      preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (preset_id, tag)
    );
    CREATE INDEX IF NOT EXISTS artwork_product_category ON artwork(product_slug, category);
    CREATE INDEX IF NOT EXISTS preset_artwork_artwork ON preset_artwork(artwork_id);`);
    this.upsertStatement = database.prepare(`INSERT INTO presets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
      product_slug=excluded.product_slug,
      name=excluded.name,
      bank=excluded.bank,
      sub_bank=excluded.sub_bank,
      author=excluded.author,
      source_fingerprint=excluded.source_fingerprint,
      state=excluded.state,
      json=excluded.json`);
    this.upsertArtworkStatement = database.prepare(`INSERT INTO artwork VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
      product_slug=excluded.product_slug,
      category=excluded.category,
      state=excluded.state,
      json=excluded.json`);
    this.assignArtworkStatement = database.prepare(`INSERT INTO preset_artwork VALUES (?, ?)
      ON CONFLICT(preset_id) DO UPDATE SET artwork_id=excluded.artwork_id`);
  }

  upsert(record) {
    this.upsertStatement.run(
      record.id,
      record.productSlug,
      record.name,
      record.bank,
      record.subBank,
      record.author,
      record.sourceFingerprint,
      record.state,
      JSON.stringify(record)
    );
  }

  search({ productSlug, query = "", favorite, tags = [] }) {
    const requiredTags = normalizeTags(tags);
    return this.database
      .prepare(
        `SELECT presets.json, preset_artwork.artwork_id,
                COALESCE(preset_metadata.favorite, 0) AS favorite,
                COALESCE(preset_metadata.revision, 0) AS revision,
                COALESCE((SELECT json_group_array(tag) FROM
                  (SELECT tag FROM preset_tags WHERE preset_id = presets.id ORDER BY tag)), '[]') AS tags_json
         FROM presets LEFT JOIN preset_artwork ON preset_artwork.preset_id = presets.id
         LEFT JOIN preset_metadata ON preset_metadata.preset_id = presets.id
         WHERE presets.product_slug = ? AND lower(presets.name) LIKE ? ORDER BY presets.id`
      )
      .all(productSlug, `%${query.toLowerCase()}%`)
      .map((row) => this.#presetFromRow(row))
      .filter((record) => favorite === undefined || record.metadata.favorite === favorite)
      .filter((record) => requiredTags.every((tag) => record.metadata.tags.includes(tag)));
  }

  get(id) {
    const row = this.database.prepare(
      `SELECT presets.json, preset_artwork.artwork_id,
              COALESCE(preset_metadata.favorite, 0) AS favorite,
              COALESCE(preset_metadata.revision, 0) AS revision,
              COALESCE((SELECT json_group_array(tag) FROM
                (SELECT tag FROM preset_tags WHERE preset_id = presets.id ORDER BY tag)), '[]') AS tags_json
       FROM presets LEFT JOIN preset_artwork ON preset_artwork.preset_id = presets.id
       LEFT JOIN preset_metadata ON preset_metadata.preset_id = presets.id
       WHERE presets.id = ?`
    ).get(id);
    return row && this.#presetFromRow(row);
  }

  upsertArtwork(record) {
    this.upsertArtworkStatement.run(
      record.id,
      record.productSlug,
      record.category || "miscellaneous",
      record.state,
      JSON.stringify(record)
    );
  }

  assignArtwork(presetId, artworkId) {
    const preset = this.database.prepare("SELECT id FROM presets WHERE id = ?").get(presetId);
    if (!preset) throw new Error(`unknown preset ${presetId}`);
    const artwork = this.database.prepare("SELECT state FROM artwork WHERE id = ?").get(artworkId);
    if (!artwork) throw new Error(`unknown artwork ${artworkId}`);
    if (artwork.state !== "approved") throw new Error(`artwork is not approved: ${artworkId}`);
    this.assignArtworkStatement.run(presetId, artworkId);
  }

  getArtwork(id) {
    const row = this.database.prepare("SELECT json FROM artwork WHERE id = ?").get(id);
    return row && JSON.parse(row.json);
  }

  artworkForPreset(presetId) {
    const row = this.database.prepare(
      `SELECT artwork.json FROM artwork
       JOIN preset_artwork ON preset_artwork.artwork_id = artwork.id
       WHERE preset_artwork.preset_id = ?`
    ).get(presetId);
    return row && JSON.parse(row.json);
  }

  products() {
    return this.database.prepare(
      "SELECT product_slug AS productSlug, count(*) AS count FROM presets GROUP BY product_slug ORDER BY product_slug"
    ).all();
  }

  metadata(presetId) {
    if (!this.database.prepare("SELECT 1 FROM presets WHERE id = ?").get(presetId)) {
      throw new Error(`unknown preset ${presetId}`);
    }
    const row = this.database.prepare(
      `SELECT favorite, revision FROM preset_metadata WHERE preset_id = ?`
    ).get(presetId);
    const tags = this.database.prepare(
      "SELECT tag FROM preset_tags WHERE preset_id = ? ORDER BY tag"
    ).all(presetId).map(({ tag }) => tag);
    return { favorite: Boolean(row?.favorite), tags, revision: row?.revision || 0 };
  }

  planMetadataUpdate(presetId, expectedRevision, changes) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("expected metadata revision must be a non-negative integer");
    if (changes.favorite === undefined && changes.tags === undefined) throw new Error("favorite or tags is required");
    if (changes.favorite !== undefined && typeof changes.favorite !== "boolean") throw new Error("favorite must be boolean");
    const before = this.metadata(presetId);
    if (before.revision !== expectedRevision) {
      throw new Error(`metadata revision mismatch: expected ${expectedRevision}, observed ${before.revision}`);
    }
    return { before, after: {
      favorite: changes.favorite ?? before.favorite,
      tags: changes.tags === undefined ? before.tags : normalizeTags(changes.tags),
      revision: before.revision + 1
    } };
  }

  setMetadata(presetId, expectedRevision, changes) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const plan = this.planMetadataUpdate(presetId, expectedRevision, changes);
      this.database.prepare(
        `INSERT INTO preset_metadata (preset_id, favorite, revision) VALUES (?, ?, ?)
         ON CONFLICT(preset_id) DO UPDATE SET favorite=excluded.favorite, revision=excluded.revision`
      ).run(presetId, plan.after.favorite ? 1 : 0, plan.after.revision);
      this.database.prepare("DELETE FROM preset_tags WHERE preset_id = ?").run(presetId);
      const insertTag = this.database.prepare("INSERT INTO preset_tags (preset_id, tag) VALUES (?, ?)");
      for (const tag of plan.after.tags) insertTag.run(presetId, tag);
      this.database.exec("COMMIT");
      return plan.after;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  exportJson() {
    const records = this.database
      .prepare(
        `SELECT presets.json, preset_artwork.artwork_id,
                COALESCE(preset_metadata.favorite, 0) AS favorite,
                COALESCE(preset_metadata.revision, 0) AS revision,
                COALESCE((SELECT json_group_array(tag) FROM
                  (SELECT tag FROM preset_tags WHERE preset_id = presets.id ORDER BY tag)), '[]') AS tags_json
         FROM presets LEFT JOIN preset_artwork ON preset_artwork.preset_id = presets.id
         LEFT JOIN preset_metadata ON preset_metadata.preset_id = presets.id
         ORDER BY presets.id`
      )
      .all()
      .map((row) => this.#presetFromRow(row));
    return `${JSON.stringify({ version: 1, records }, null, 2)}\n`;
  }

  #presetFromRow(row) {
    const record = JSON.parse(row.json);
    const enriched = { ...record, metadata: {
      favorite: Boolean(row.favorite), tags: JSON.parse(row.tags_json), revision: row.revision
    } };
    return row.artwork_id ? { ...enriched, artworkId: row.artwork_id } : enriched;
  }

  close() {
    this.database.close();
  }
}
