import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class ManifestStore {
  static async open(path) {
    let records = [];
    try {
      records = JSON.parse(await readFile(path, "utf8")).records;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return new ManifestStore(path, records);
  }

  constructor(path, records) {
    this.path = path;
    this.records = new Map(records.map((item) => [item.id, item]));
  }

  async upsert(record) {
    this.records.set(record.id, structuredClone(record));
  }

  get(id) {
    const value = this.records.get(id);
    return value && structuredClone(value);
  }

  list(productSlug) {
    return [...this.records.values()]
      .filter((item) => item.productSlug === productSlug)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => structuredClone(item));
  }

  pending(productSlug) {
    return [...this.records.values()]
      .filter(
        (item) =>
          item.productSlug === productSlug && !["validated", "quarantined"].includes(item.state)
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async flush() {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    const records = [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
    await writeFile(temp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}
