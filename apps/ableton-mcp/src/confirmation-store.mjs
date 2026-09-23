import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashPlan(plan) {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}

export class ConfirmationStore {
  constructor({ ttlMs = 60000 } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  issue(plan, now = Date.now()) {
    const token = randomBytes(24).toString("base64url");
    const planHash = hashPlan(plan);
    this.entries.set(token, { plan: structuredClone(plan), planHash, expiresAt: now + this.ttlMs });
    return { token, planHash, expiresAt: now + this.ttlMs };
  }

  consume(token, expectedPlanHash, now = Date.now()) {
    const entry = this.entries.get(token);
    if (!entry) throw new Error("unknown confirmation token");
    if (now > entry.expiresAt) {
      this.entries.delete(token);
      throw new Error("confirmation token expired");
    }
    const actual = Buffer.from(entry.planHash, "hex");
    const expected = Buffer.from(expectedPlanHash, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("confirmation plan hash mismatch");
    }
    this.entries.delete(token);
    return structuredClone(entry.plan);
  }
}

function entryName(token) {
  return `${createHash("sha256").update(token).digest("hex")}.json`;
}

function verifyEntry(entry, expectedPlanHash, now) {
  if (now > entry.expiresAt) throw new Error("confirmation token expired");
  const actual = Buffer.from(entry.planHash, "hex");
  const expected = Buffer.from(expectedPlanHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("confirmation plan hash mismatch");
  }
  return structuredClone(entry.plan);
}

export class FileConfirmationStore {
  constructor({ directory, ttlMs = 60000 }) {
    if (!directory) throw new Error("confirmation directory is required");
    this.directory = directory;
    this.ttlMs = ttlMs;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  issue(plan, now = Date.now()) {
    this.#pruneExpired(now);
    const token = randomBytes(24).toString("base64url");
    const planHash = hashPlan(plan);
    const expiresAt = now + this.ttlMs;
    const path = join(this.directory, entryName(token));
    const pending = `${path}.pending-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      writeFileSync(pending, JSON.stringify({ plan: structuredClone(plan), planHash, expiresAt }), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      renameSync(pending, path);
    } finally {
      try { unlinkSync(pending); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return { token, planHash, expiresAt };
  }

  #pruneExpired(now) {
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      try {
        const entry = JSON.parse(readFileSync(path, "utf8"));
        if (now > entry.expiresAt) unlinkSync(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  consume(token, expectedPlanHash, now = Date.now()) {
    const path = join(this.directory, entryName(token));
    const claimed = `${path}.consuming-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      renameSync(path, claimed);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("unknown confirmation token");
      throw error;
    }
    try {
      return verifyEntry(JSON.parse(readFileSync(claimed, "utf8")), expectedPlanHash, now);
    } finally {
      try { unlinkSync(claimed); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}
