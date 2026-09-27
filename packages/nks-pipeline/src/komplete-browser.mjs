import { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute, relative, resolve } from "node:path";

function inside(root, path) {
  const remainder = relative(resolve(root), resolve(path));
  return remainder !== "" && remainder !== ".." && !remainder.startsWith("../") && !isAbsolute(remainder);
}

export class KompleteBrowser {
  static open(path) {
    return new KompleteBrowser(new DatabaseSync(path, { readOnly: true }));
  }

  constructor(database) {
    this.database = database;
    this.findRows = database.prepare(`SELECT name, product, file_name, file_ext
      FROM v_sound_info WHERE name = ? AND product = ? ORDER BY file_name`);
    this.findRoot = database.prepare(`SELECT 1 FROM k_content_path WHERE path = ? AND visible = 1 LIMIT 1`);
  }

  findSavedPreset({ name, product, fileName, userContentRoot }) {
    if (typeof fileName !== "string" || !fileName.toLowerCase().endsWith(".nksf") ||
        typeof userContentRoot !== "string" || !isAbsolute(userContentRoot) ||
        !this.findRoot.get(userContentRoot)) return undefined;
    const matches = this.findRows.all(name, product).filter(row =>
      row.file_ext?.toLowerCase() === "nksf" &&
      basename(row.file_name) === fileName && inside(userContentRoot, row.file_name));
    if (matches.length > 1) throw new Error(`ambiguous Komplete index for ${product} / ${name} / ${fileName}`);
    if (!matches.length) return undefined;
    const row = matches[0];
    return { name: row.name, product: row.product, fileName: row.file_name, fileExt: row.file_ext };
  }

  close() {
    this.database.close();
  }
}
