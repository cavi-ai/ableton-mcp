import { DatabaseSync } from "node:sqlite";
import { basename, relative, resolve } from "node:path";

function isInside(root, file) {
  const path = relative(resolve(root), resolve(file));
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
}

export class KompleteBrowser {
  static open(path) {
    return new KompleteBrowser(new DatabaseSync(path, { readOnly: true }));
  }

  constructor(database) {
    this.database = database;
    this.findStatement = database.prepare(`
      SELECT name, product, file_name, file_ext
      FROM v_sound_info
      WHERE name = ? AND product = ?
      ORDER BY file_name
    `);
    this.contentRootStatement = database.prepare(`
      SELECT path
      FROM k_content_path
      WHERE path = ? AND visible = 1
      LIMIT 1
    `);
  }

  findSavedPreset({ name, product, fileName, userContentRoot }) {
    if (!fileName.toLowerCase().endsWith(".nksf")) return undefined;
    if (!this.contentRootStatement.get(userContentRoot)) return undefined;

    const row = this.findStatement
      .all(name, product)
      .find((candidate) =>
        candidate.file_ext.toLowerCase() === "nksf" &&
        basename(candidate.file_name) === fileName &&
        isInside(userContentRoot, candidate.file_name)
      );
    if (!row) return undefined;
    return {
      name: row.name,
      product: row.product,
      fileName: row.file_name,
      fileExt: row.file_ext
    };
  }

  close() {
    this.database.close();
  }
}
