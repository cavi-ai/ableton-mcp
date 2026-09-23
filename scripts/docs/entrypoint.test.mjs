import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "./lib.mjs";

test("docs scripts run when invoked through a symlinked path", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ableton-mcp-docs-link-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const link = path.join(temporary, "repo");
  await symlink(REPO_ROOT, link);
  const stdout = execFileSync(process.execPath, [
    path.join(link, "scripts/docs/create-release-envelope.mjs"),
    "--version", "1.2.3",
    "--tag", "v1.2.3",
    "--repository", "cavi-ai/ableton-mcp",
    "--commit", "0123456789abcdef0123456789abcdef01234567",
    "--artifact-sha256", "a".repeat(64)
  ], { encoding: "utf8" });
  assert.equal(JSON.parse(stdout).artifact.format, "tar.gz");
});
