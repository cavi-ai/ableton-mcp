import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SnapshotLibrary } from "../src/snapshot-library.mjs";

test("track snapshot library persists and reads a named capture without overwriting", async () => {
  const directory = await mkdtemp(`${tmpdir()}/cavi-snapshot-test-`);
  try {
    const library = new SnapshotLibrary({ directory });
    const snapshot = { format: "cavi-track-state-v1", track: { name: "Bass", type: "midi", isGroup: false },
      mixer: {}, routing: {}, devices: [] };
    const saved = await library.save("bass-template", snapshot);
    assert.equal(saved.name, "bass-template");
    assert.deepEqual((await library.load("bass-template")).snapshot, snapshot);
    await assert.rejects(() => library.save("bass-template", { ...snapshot, track: { ...snapshot.track, name: "Changed" } }), /already exists/);
    assert.deepEqual((await library.load("bass-template")).snapshot, snapshot);
    await assert.rejects(() => library.load("../outside"), /invalid snapshot name/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("track snapshot library refuses symlinked entries and oversized captures", async () => {
  const directory = await mkdtemp(`${tmpdir()}/cavi-snapshot-test-`);
  try {
    const library = new SnapshotLibrary({ directory });
    await writeFile(`${directory}/outside.json`, JSON.stringify({ format: "cavi-track-state-v1" }));
    await symlink(`${directory}/outside.json`, `${directory}/link.json`);
    await assert.rejects(() => library.load("link"), /symlink/);
    await assert.rejects(() => library.save("huge", { format: "cavi-track-state-v1", payload: "x".repeat(5 * 1024 * 1024) }), /too large/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
