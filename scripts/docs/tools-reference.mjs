import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { toolContracts } from "../../apps/ableton-mcp/src/tool-contracts.mjs";
import { REPO_ROOT, SOURCE_REL, isEntrypoint } from "./lib.mjs";

export const TOOLS_REFERENCE_PATH = path.join(REPO_ROOT, SOURCE_REL, "pages/reference/tools.md");

const GROUPS = [
  ["Read-only", (annotations) => annotations.readOnlyHint],
  ["Mutations", (annotations) => !annotations.readOnlyHint && !annotations.destructiveHint],
  ["Destructive mutations", (annotations) => annotations.destructiveHint]
];

function cell(text) {
  return text.replace(/\s+/gu, " ").replaceAll("|", "\\|").trim();
}

export function renderToolsReference(contracts = toolContracts) {
  const names = Object.keys(contracts).sort();
  const lines = [
    "# Tools",
    "",
    "Generated from `apps/ableton-mcp/src/tool-contracts.mjs` by `node scripts/docs/tools-reference.mjs`. Do not edit by hand.",
    "",
    `The server publishes ${names.length} tools. Mutations of the Live Set require \`expectedStateVersion\`; metadata edits require \`expectedMetadataRevision\`. A guarded mutation returns a plan when \`dryRun\` is omitted or true, and executes only with the single-use \`confirmationToken\` and \`planHash\` from that plan.`
  ];
  for (const [title, matches] of GROUPS) {
    const group = names.filter((name) => matches(contracts[name].annotations));
    lines.push("", `## ${title} (${group.length})`, "", "| Tool | Description | Required arguments |", "|---|---|---|");
    for (const name of group) {
      const required = (contracts[name].inputSchema.required ?? []).map((argument) => `\`${argument}\``).join(", ");
      lines.push(`| \`${name}\` | ${cell(contracts[name].description)} | ${required || "none"} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

if (isEntrypoint(import.meta)) {
  const expected = renderToolsReference();
  if (process.argv.includes("--check")) {
    const actual = await readFile(TOOLS_REFERENCE_PATH, "utf8").catch(() => "");
    if (actual !== expected) {
      process.stderr.write("tools reference is stale: run node scripts/docs/tools-reference.mjs\n");
      process.exitCode = 1;
    }
  } else {
    await writeFile(TOOLS_REFERENCE_PATH, expected);
    process.stdout.write(`${path.relative(REPO_ROOT, TOOLS_REFERENCE_PATH)}\n`);
  }
}
