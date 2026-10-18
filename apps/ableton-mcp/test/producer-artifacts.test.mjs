import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProducerArtifacts } from "../src/producer-artifacts.mjs";

async function store(t) {
  const directory = await mkdtemp(join(tmpdir(), "producer-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, artifacts: new ProducerArtifacts(directory) };
}

test("artifacts are private, immutable, content addressed and project scoped", async t => {
  const { artifacts, directory } = await store(t);
  const id = artifacts.put("song", "context", { notes: [60, 64] });
  assert.equal(artifacts.put("song", "context", { notes: [60, 64] }), id);
  assert.deepEqual(artifacts.get("song", id).value, { notes: [60, 64] });
  assert.throws(() => artifacts.get("another-song", id), /artifact/);
  assert.throws(() => artifacts.put("../escape", "context", {}), /projectId/);
  assert.throws(() => artifacts.get("song", "../escape"), /artifactId/);
  const path = join(directory, "song", `${id}.json`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{}');
  assert.throws(() => artifacts.get("song", id), /integrity/);
});

test("artifact paging is bounded and reports remaining content", async t => {
  const { artifacts } = await store(t);
  const id = artifacts.put("song", "context", { data: "a".repeat(20000) });
  const page = artifacts.page("song", id, 0, 100);
  assert.equal(page.text.length, 100);
  assert.equal(page.nextOffset, 100);
  assert.equal(page.truncated, true);
  assert.throws(() => artifacts.page("song", id, -1, 100), /offset/);
  assert.throws(() => artifacts.page("song", id, 0, 100000), /limit/);
  assert.throws(() => artifacts.put("song", "context", { data: "a".repeat(2100000) }), /limit/);
});

test("artifact reads and writes reject symlinked project directories and files", async t => {
  const { artifacts, directory } = await store(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await symlink(outside, join(directory, "linked"));
  assert.throws(() => artifacts.put("linked", "context", {}), /symlink|directory/);
  const id = artifacts.put("song", "context", {});
  const path = join(directory, "song", `${id}.json`);
  const contents = await readFile(path);
  await rm(path);
  await writeFile(join(outside, "data"), contents);
  await symlink(join(outside, "data"), path);
  assert.throws(() => artifacts.get("song", id), /symlink|symbolic|ELOOP/);
});


test("session revisions survive reopening and reject concurrent stale writers", async t => {
  const { artifacts, directory } = await store(t);
  const created = artifacts.createSession("song", { goal: "Preserve the bass", phase: "inspect" });
  const reopened = new ProducerArtifacts(directory);
  assert.equal(reopened.session("song", created.sessionId).value.goal, "Preserve the bass");
  const updated = reopened.advanceSession("song", created.sessionId, 1, { goal: "Preserve the bass", phase: "choose" });
  assert.equal(updated.value.revision, 2);
  assert.equal(updated.value.previousRef, created.sessionRef);
  assert.throws(() => artifacts.advanceSession("song", created.sessionId, 1, { phase: "apply" }), /revision/);
  assert.equal(artifacts.session("song", created.sessionId).value.phase, "choose");
  assert.throws(() => reopened.session("other", created.sessionId), /not found/);
  assert.equal(reopened.sessions("song").sessions[0].sessionId, created.sessionId);
  assert.equal(artifacts.get("song", created.sessionRef).value.phase, "inspect");
});
