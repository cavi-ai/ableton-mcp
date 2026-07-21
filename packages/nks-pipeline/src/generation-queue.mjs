function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class GenerationQueue {
  #records;
  #leaseMs;
  #maxAttempts;

  constructor(records, { leaseMs = 60000, maxAttempts = 3 } = {}) {
    this.#records = new Map(records.map((record) => [record.id, {
      ...clone(record),
      attempts: record.attempts ?? 0,
      evidence: clone(record.evidence ?? [])
    }]));
    this.#leaseMs = leaseMs;
    this.#maxAttempts = maxAttempts;
  }

  get(id) {
    return clone(this.#records.get(id));
  }

  lease(workerId, now = Date.now()) {
    const record = [...this.#records.values()]
      .filter((candidate) => candidate.state === "discovered")
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!record) return undefined;

    record.state = "loading";
    record.workerId = workerId;
    record.leaseExpiresAt = now + this.#leaseMs;
    record.attempts += 1;
    record.evidence.push({ state: "loading", workerId, at: now });
    return clone(record);
  }

  heartbeat(id, workerId, now = Date.now()) {
    const record = this.#ownedLease(id, workerId);
    record.leaseExpiresAt = now + this.#leaseMs;
    return clone(record);
  }

  recoverStale(now = Date.now()) {
    let recovered = 0;
    for (const record of this.#records.values()) {
      if (record.state !== "loading" || record.leaseExpiresAt >= now) continue;
      const previousWorkerId = record.workerId;
      record.state = "discovered";
      delete record.workerId;
      delete record.leaseExpiresAt;
      record.evidence.push({ state: "discovered", reason: "stale_lease", previousWorkerId, at: now });
      recovered += 1;
    }
    return recovered;
  }

  complete(id, workerId, nextState, evidence = {}, now = Date.now()) {
    const record = this.#ownedLease(id, workerId);
    record.state = nextState;
    delete record.workerId;
    delete record.leaseExpiresAt;
    record.evidence.push({ state: nextState, ...clone(evidence), at: now });
    return clone(record);
  }

  fail(id, workerId, reason, now = Date.now()) {
    const record = this.#ownedLease(id, workerId);
    record.state = record.attempts >= this.#maxAttempts ? "quarantined" : "discovered";
    delete record.workerId;
    delete record.leaseExpiresAt;
    record.evidence.push({ state: record.state, reason, at: now });
    return clone(record);
  }

  #ownedLease(id, workerId) {
    const record = this.#records.get(id);
    if (!record) throw new Error(`unknown generation record ${id}`);
    if (record.state !== "loading" || record.workerId !== workerId) {
      throw new Error(`generation record ${id} is not leased by ${workerId}`);
    }
    return record;
  }
}
