import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";

test("MCP discovery exposes every contracted producer tool", async () => {
  const listed = await createRouter(new ToolService({}))({ id: 1, method: "tools/list" });
  const tools = listed.result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(toolContracts).sort());
  for (const name of ["create_rack_chain", "move_device_to_chain"]) {
    assert.equal(tools.find(tool => tool.name === name).inputSchema.additionalProperties, false);
  }
  const metadata = tools.find(tool => tool.name === "set_browser_item_metadata");
  assert.deepEqual(metadata.inputSchema.required, ["expectedMetadataRevision", "root", "path"]);
  assert.match(metadata.description, /private|native/i);
});
