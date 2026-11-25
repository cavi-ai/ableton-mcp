import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toolSlices } from "../src/tool-slices.mjs";

const server = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const removed = [
  "advance_production_session", "apply_production_operation", "get_producer_workflow", "get_production_context",
  "get_production_session", "read_production_artifact", "record_production_note", "run_production_task",
  "start_production_session"
];

function serve(selection) {
  const { ABLETON_MCP_TOOL_PROFILE, ABLETON_MCP_TOOL_SLICES, ABLETON_MCP_TOOLS, ...environment } = process.env;
  const input = [{ id: 1, method: "tools/list" }, { id: 2, method: "prompts/list" }]
    .map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], { input, encoding: "utf8",
    env: { ...environment, ABLETON_MCP_FIXTURE: "1", ...selection } });
  const replies = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { status: run.status, stderr: run.stderr, reply: (id) => replies.find((reply) => reply.id === id)?.result };
}

const selections = [
  ...["all", "core", "directory"].map((profile) => ({ ABLETON_MCP_TOOL_PROFILE: profile })),
  ...Object.keys(toolSlices).map((slice) => ({ ABLETON_MCP_TOOL_SLICES: slice })),
  { ABLETON_MCP_TOOL_SLICES: Object.keys(toolSlices).join(",") }
];

test("every profile and slice lists functional tools only and no prompts", () => {
  for (const selection of selections) {
    const session = serve(selection);
    const label = JSON.stringify(selection);
    assert.equal(session.status, 0, `${label}: ${session.stderr}`);
    const names = session.reply(1).tools.map((tool) => tool.name);
    assert.ok(names.length > 0, label);
    assert.deepEqual(names.filter((name) => removed.includes(name)), [], label);
    assert.deepEqual(session.reply(2).prompts, [], label);
  }
});

test("the all profile lists exactly the slice tools", () => {
  const names = serve({ ABLETON_MCP_TOOL_PROFILE: "all" }).reply(1).tools.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [...new Set(Object.values(toolSlices).flat())].sort());
});

test("the producer profile is rejected at startup", () => {
  const session = serve({ ABLETON_MCP_TOOL_PROFILE: "producer" });
  assert.equal(session.status, 2);
  assert.match(session.stderr, /unknown tool profile: producer/);
});
