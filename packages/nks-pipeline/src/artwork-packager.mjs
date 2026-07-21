import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

function checksum(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

function assertInside(root, path) {
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || resolve(root, value) !== path) {
    throw new Error(`install path escapes target root: ${path}`);
  }
}

export function buildInstallPlan({ stageRoot, targetRoot }) {
  const absoluteStage = resolve(stageRoot);
  const absoluteTarget = resolve(targetRoot);
  if (!existsSync(absoluteStage) || !statSync(absoluteStage).isDirectory()) {
    throw new Error(`stage root does not exist: ${absoluteStage}`);
  }
  const copies = [];
  const skipped = [];
  const errors = [];
  for (const source of filesUnder(absoluteStage)) {
    const relativePath = relative(absoluteStage, source);
    const destination = resolve(absoluteTarget, relativePath);
    assertInside(absoluteTarget, destination);
    const sourceChecksum = checksum(source);
    if (existsSync(destination) && checksum(destination) === sourceChecksum) {
      skipped.push({ source, destination, checksum: sourceChecksum });
    } else {
      copies.push({ source, destination, checksum: sourceChecksum });
    }
  }
  return { stageRoot: absoluteStage, targetRoot: absoluteTarget, copies, skipped, errors };
}

export function applyInstallPlan(plan, { apply = false } = {}) {
  if (plan.errors.length > 0) throw new Error(`install plan has ${plan.errors.length} errors`);
  if (!apply) return { applied: false, copied: 0, skipped: plan.skipped.length };
  for (const item of plan.copies) {
    assertInside(plan.targetRoot, item.destination);
    mkdirSync(dirname(item.destination), { recursive: true });
    copyFileSync(item.source, item.destination);
    if (checksum(item.destination) !== item.checksum) {
      throw new Error(`installed checksum mismatch: ${item.destination}`);
    }
  }
  return { applied: true, copied: plan.copies.length, skipped: plan.skipped.length };
}
