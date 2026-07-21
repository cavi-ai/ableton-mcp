import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("stdio server initializes and lists MCP resources and tools", async () => {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ABLETON_NKS_MCP_FIXTURE: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_presets", arguments: { productSlug: "serum-2", query: "Deep" } } }
    ,{ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "ableton://live/status" } }
  ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  await once(child, "exit");
  const messages = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].result.serverInfo.name, "ableton-nks-mcp");
  assert.equal(messages[1].result.resources.length, 8);
  assert.equal(
    messages[1].result.resources.some(({ uri }) => uri === "nks://catalog/artwork/{artwork_id}"),
    true
  );
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "set_device_parameters"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "list_tracks"), true);
  assert.equal(messages[2].result.tools.some((tool) => tool.name === "list_devices"), true);
  assert.equal(messages[3].result.content[0].type, "text");
  assert.equal(JSON.parse(messages[4].result.contents[0].text).method, "get_live_state");
  assert.match(stderr, /fixture mode/);
  assert.equal(stdout.includes("fixture mode"), false);
});
