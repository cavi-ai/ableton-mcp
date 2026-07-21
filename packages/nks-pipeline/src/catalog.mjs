import { DatabaseSync } from "node:sqlite";

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

  search({ productSlug, query = "" }) {
    return this.database
      .prepare(
        `SELECT presets.json, preset_artwork.artwork_id
         FROM presets LEFT JOIN preset_artwork ON preset_artwork.preset_id = presets.id
         WHERE presets.product_slug = ? AND lower(presets.name) LIKE ? ORDER BY presets.id`
      )
      .all(productSlug, `%${query.toLowerCase()}%`)
      .map((row) => this.#presetFromRow(row));
  }

  get(id) {
    const row = this.database.prepare(
      `SELECT presets.json, preset_artwork.artwork_id
       FROM presets LEFT JOIN preset_artwork ON preset_artwork.preset_id = presets.id
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

  exportJson() {
    const records = this.database
      .prepare(
        `SELECT presets.json, preset_artwork.artwork_id
         FROM presets LEFT JOIN preset_artwork ON preset_artwork.preset_id = presets.id
         ORDER BY presets.id`
      )
      .all()
      .map((row) => this.#presetFromRow(row));
    return `${JSON.stringify({ version: 1, records }, null, 2)}\n`;
  }

  #presetFromRow(row) {
    const record = JSON.parse(row.json);
    return row.artwork_id ? { ...record, artworkId: row.artwork_id } : record;
  }

  close() {
    this.database.close();
  }
}
