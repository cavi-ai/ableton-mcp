import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { buildSerumPilot } from "./serum-pilot.mjs";

function candidatesFor(database, productSlug) {
  const candidates = database.prepare(`SELECT id, source_fingerprint AS fingerprint FROM presets
    WHERE product_slug = ? AND state = 'discovered'
      AND COALESCE(json_extract(json, '$.missing'), 0) = 0 ORDER BY id`).all(productSlug);
  return { eligible: candidates.length,
    fingerprint: createHash("sha256").update(JSON.stringify(candidates)).digest("hex") };
}

const isUserSource = record => record.sourceRelativePath.split("/")
  .some(part => part.toLowerCase() === "user");

function serumPilotState(database) {
  const records = database.prepare(`SELECT json FROM presets WHERE product_slug = ?
    AND COALESCE(json_extract(json, '$.missing'), 0) = 0 ORDER BY id`).all("serum-2")
    .map(row => JSON.parse(row.json));
  if (records.some(record => typeof record.sourceRelativePath !== "string" || !record.sourceRelativePath))
    throw new Error("Serum pilot requires catalog source-relative paths");
  const factory = records.filter(record => !isUserSource(record));
  const factoryIds = new Set(factory.map(record => record.id));
  const pilotIds = new Set(factory.length ? buildSerumPilot(factory).jobs.map(job => job.id) : []);
  const validated = factory.filter(record => pilotIds.has(record.id) && record.state === "validated" &&
    record.evidence?.some(item => item.state === "validated")).length;
  const gateOpen = pilotIds.size > 0 && validated === pilotIds.size;
  const queueable = factory.filter(record => record.state === "discovered" &&
    (gateOpen || pilotIds.has(record.id))).length;
  return { pilotIds, factoryIds, status: { total: pilotIds.size, validated, gateOpen, queueable } };
}

function selectedCandidates(database, productSlug, presetIds) {
  if (typeof productSlug !== "string" || !productSlug.trim()) throw new Error("productSlug is required");
  if (!Array.isArray(presetIds) || presetIds.length < 1 || presetIds.length > 100 ||
      presetIds.some(id => typeof id !== "string" || !id.trim()) || new Set(presetIds).size !== presetIds.length)
    throw new Error("presetIds must contain 1 to 100 unique nonempty IDs");
  const sortedIds = [...presetIds].sort();
  const placeholders = sortedIds.map(() => "?").join(", ");
  const candidates = database.prepare(`SELECT id, source_fingerprint AS fingerprint FROM presets
    WHERE product_slug = ? AND state = 'discovered'
      AND COALESCE(json_extract(json, '$.missing'), 0) = 0
      AND id IN (${placeholders}) ORDER BY id`).all(productSlug, ...sortedIds);
  if (candidates.length !== sortedIds.length) throw new Error("presetIds must all be eligible discovered presets for productSlug");
  if (productSlug === "serum-2") {
    const { pilotIds, factoryIds, status } = serumPilotState(database);
    if (sortedIds.some(id => !factoryIds.has(id)))
      throw new Error("User-source presets are not Serum factory jobs");
    if (!status.gateOpen && sortedIds.some(id => !pilotIds.has(id)))
      throw new Error("Serum pilot must be validated before enqueuing other factory presets");
  }
  return { productSlug, presetIds: sortedIds, eligible: candidates.length,
    fingerprint: createHash("sha256").update(JSON.stringify(candidates)).digest("hex") };
}

export class GenerationQueue {
  static inspectSelection(path, productSlug, presetIds) {
    const database = new DatabaseSync(path, { readOnly: true });
    try { return selectedCandidates(database, productSlug, presetIds); }
    finally { database.close(); }
  }

  static inspect(path, productSlug) {
    if (typeof productSlug !== "string" || !productSlug.trim()) throw new Error("productSlug is required");
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const { eligible, fingerprint } = candidatesFor(database, productSlug);
      const pilot = productSlug === "serum-2" ? serumPilotState(database).status : undefined;
      const initialized = Boolean(database.prepare(`SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'nks_generation_jobs'`).get());
      const jobs = initialized ? Object.fromEntries(database.prepare(`SELECT j.status, count(*) AS count
        FROM nks_generation_jobs j JOIN presets p ON p.id = j.preset_id
        WHERE p.product_slug = ? GROUP BY j.status ORDER BY j.status`).all(productSlug)
        .map(({ status, count }) => [status, count])) : {};
      return { productSlug, eligible, fingerprint, initialized, jobs, ...(pilot && { pilot }) };
    } finally {
      database.close();
    }
  }

  static inspectJob(path, presetId) {
    if (typeof presetId !== "string" || !presetId.trim()) throw new Error("presetId is required");
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      if (!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table'
        AND name = 'nks_generation_jobs'`).get()) return { job: null, events: [] };
      const job = database.prepare(`SELECT preset_id AS presetId, source_fingerprint AS sourceFingerprint,
        status, attempts, worker_id AS workerId, lease_expires_at AS leaseExpiresAt,
        last_error AS lastError FROM nks_generation_jobs WHERE preset_id = ?`).get(presetId) ?? null;
      const events = job ? database.prepare(`SELECT kind, worker_id AS workerId, at_ms AS atMs, detail
        FROM nks_generation_events WHERE preset_id = ? ORDER BY id`).all(presetId) : [];
      return { job, events };
    } finally {
      database.close();
    }
  }

  static open(path, options) {
    return new GenerationQueue(new DatabaseSync(path), options);
  }

  constructor(database, { leaseMs = 60000, maxAttempts = 3 } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(maxAttempts) || maxAttempts <= 0)
      throw new Error("leaseMs and maxAttempts must be positive integers");
    this.database = database;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS nks_generation_jobs (
        preset_id TEXT PRIMARY KEY REFERENCES presets(id) ON DELETE CASCADE,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'quarantined', 'done')),
        attempts INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT,
        lease_expires_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS nks_generation_jobs_status ON nks_generation_jobs(status, preset_id);`);
    database.exec(`CREATE TABLE IF NOT EXISTS nks_generation_events (
      id INTEGER PRIMARY KEY,
      preset_id TEXT NOT NULL REFERENCES nks_generation_jobs(preset_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      worker_id TEXT,
      at_ms INTEGER NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS nks_generation_events_preset ON nks_generation_events(preset_id, id);`);
  }

  #transaction(action) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  enqueue(productSlug, presetIds, expectedFingerprint) {
    return this.#transaction(() => {
      const selection = selectedCandidates(this.database, productSlug, presetIds);
      if (expectedFingerprint !== undefined && selection.fingerprint !== expectedFingerprint)
        throw new Error("confirmation plan hash mismatch: catalog candidates changed");
      const placeholders = selection.presetIds.map(() => "?").join(", ");
      return this.database.prepare(`INSERT INTO nks_generation_jobs
      (preset_id, source_fingerprint, status, attempts)
      SELECT id, source_fingerprint, 'pending', 0 FROM presets
      WHERE product_slug = ? AND id IN (${placeholders}) AND state = 'discovered'
        AND COALESCE(json_extract(json, '$.missing'), 0) = 0
      ON CONFLICT(preset_id) DO UPDATE SET source_fingerprint = excluded.source_fingerprint,
        status = 'pending', attempts = 0, worker_id = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE nks_generation_jobs.source_fingerprint != excluded.source_fingerprint`)
        .run(productSlug, ...selection.presetIds).changes;
    });
  }

  get(presetId) {
    return this.database.prepare(`SELECT preset_id AS presetId, source_fingerprint AS sourceFingerprint,
      status, attempts, worker_id AS workerId, lease_expires_at AS leaseExpiresAt,
      last_error AS lastError FROM nks_generation_jobs WHERE preset_id = ?`).get(presetId);
  }

  #event(presetId, kind, workerId, now, detail = null) {
    this.database.prepare(`INSERT INTO nks_generation_events (preset_id, kind, worker_id, at_ms, detail)
      VALUES (?, ?, ?, ?, ?)`).run(presetId, kind, workerId, now, detail);
  }

  events(presetId) {
    return this.database.prepare(`SELECT kind, worker_id AS workerId, at_ms AS atMs, detail
      FROM nks_generation_events WHERE preset_id = ? ORDER BY id`).all(presetId);
  }

  claim(workerId, productSlug, now = Date.now()) {
    if (typeof workerId !== "string" || !workerId) throw new Error("workerId is required");
    return this.#transaction(() => {
      const stale = this.database.prepare(`SELECT preset_id AS presetId, worker_id AS workerId
        FROM nks_generation_jobs WHERE status = 'leased' AND lease_expires_at < ? ORDER BY preset_id`).all(now);
      for (const job of stale) this.#event(job.presetId, "stale_lease", job.workerId, now);
      this.database.prepare(`UPDATE nks_generation_jobs SET
        status = CASE WHEN attempts >= ? THEN 'quarantined' ELSE 'pending' END,
        worker_id = NULL, lease_expires_at = NULL, last_error = 'stale_lease'
        WHERE status = 'leased' AND lease_expires_at < ?`).run(this.maxAttempts, now);
      const row = this.database.prepare(`SELECT j.preset_id AS presetId FROM nks_generation_jobs j
        JOIN presets p ON p.id = j.preset_id
        WHERE j.status = 'pending' AND j.attempts < ? AND p.state = 'discovered'
          AND j.source_fingerprint = p.source_fingerprint
          AND COALESCE(json_extract(p.json, '$.missing'), 0) = 0
          AND (? IS NULL OR p.product_slug = ?)
        ORDER BY j.preset_id LIMIT 1`).get(this.maxAttempts, productSlug ?? null, productSlug ?? null);
      if (!row) return undefined;
      this.database.prepare(`UPDATE nks_generation_jobs SET status = 'leased', attempts = attempts + 1,
        worker_id = ?, lease_expires_at = ?, last_error = NULL WHERE preset_id = ?`)
        .run(workerId, now + this.leaseMs, row.presetId);
      this.#event(row.presetId, "leased", workerId, now);
      return this.get(row.presetId);
    });
  }

  #owned(presetId, workerId, now) {
    const row = this.get(presetId);
    if (!row || row.status !== "leased" || row.workerId !== workerId || row.leaseExpiresAt < now)
      throw new Error(`preset ${presetId} is not leased by ${workerId}`);
    return row;
  }

  heartbeat(presetId, workerId, now = Date.now()) {
    return this.#transaction(() => {
      this.#owned(presetId, workerId, now);
      this.database.prepare("UPDATE nks_generation_jobs SET lease_expires_at = ? WHERE preset_id = ?")
        .run(now + this.leaseMs, presetId);
      this.#event(presetId, "heartbeat", workerId, now);
      return this.get(presetId);
    });
  }

  fail(presetId, workerId, reason, now = Date.now()) {
    if (typeof reason !== "string" || !reason) throw new Error("failure reason is required");
    return this.#transaction(() => {
      const row = this.#owned(presetId, workerId, now);
      this.database.prepare(`UPDATE nks_generation_jobs SET status = ?, worker_id = NULL,
        lease_expires_at = NULL, last_error = ? WHERE preset_id = ?`)
        .run(row.attempts >= this.maxAttempts ? "quarantined" : "pending", reason, presetId);
      this.#event(presetId, row.attempts >= this.maxAttempts ? "quarantined" : "failed", workerId, now, reason);
      return this.get(presetId);
    });
  }

  completeSaved(presetId, workerId, now = Date.now()) {
    return this.#transaction(() => {
      const job = this.#owned(presetId, workerId, now);
      const row = this.database.prepare("SELECT state, source_fingerprint, json FROM presets WHERE id = ?").get(presetId);
      const evidence = row && JSON.parse(row.json).evidence?.findLast(item => item.state === "nks_saved");
      if (row?.state !== "nks_saved" || row.source_fingerprint !== job.sourceFingerprint ||
          evidence?.kind !== "komplete_index_and_file_verified" ||
          !/^[0-9a-f]{64}$/.test(evidence?.artifact?.sha256 ?? ""))
        throw new Error(`preset ${presetId} is not nks_saved with verified artifact evidence`);
      this.database.prepare(`UPDATE nks_generation_jobs SET status = 'done', worker_id = NULL,
        lease_expires_at = NULL, last_error = NULL WHERE preset_id = ?`).run(presetId);
      this.#event(presetId, "done", workerId, now, evidence.artifact.sha256);
      return this.get(presetId);
    });
  }

  counts() {
    return Object.fromEntries(this.database.prepare(
      "SELECT status, count(*) AS count FROM nks_generation_jobs GROUP BY status ORDER BY status"
    ).all().map(({ status, count }) => [status, count]));
  }

  close() {
    this.database.close();
  }
}
