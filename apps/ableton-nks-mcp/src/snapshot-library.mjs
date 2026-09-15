import { mkdir, open, readFile, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

function snapshotPath(directory, name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(name) || name === "." || name === "..")
    throw new Error("invalid snapshot name");
  return join(directory, `${name}.json`);
}

export class SnapshotLibrary {
  constructor({ directory }) {
    if (typeof directory !== "string" || !directory) throw new Error("snapshot directory is required");
    this.directory = directory;
  }

  async save(name, snapshot) {
    const path = snapshotPath(this.directory, name);
    if (snapshot?.format !== "cavi-track-state-v1") throw new Error("invalid track snapshot format");
    const content = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error("snapshot capture is too large");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(content);
    } catch (error) {
      if (handle) await unlink(path).catch(() => {});
      if (error.code === "EEXIST") throw new Error(`snapshot ${name} already exists`);
      throw error;
    } finally {
      await handle?.close();
    }
    return { name, path };
  }

  async load(name) {
    const path = snapshotPath(this.directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("snapshot entry must not be a symlink");
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("snapshot file is invalid or too large");
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    if (snapshot?.format !== "cavi-track-state-v1") throw new Error("invalid track snapshot format");
    return { name, path, snapshot };
  }
}
