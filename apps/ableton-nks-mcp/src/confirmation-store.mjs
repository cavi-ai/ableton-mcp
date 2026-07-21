import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
