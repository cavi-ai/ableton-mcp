import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";

test("ping answers without accessing Live or a catalog", async () => {
  const reply = await createRouter({})({ id: 1, method: "ping" });
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 1, result: {} });
});

test("scale names advertised by discovery resolve through the real service", async () => {
  const route = createRouter(new ToolService({}));
  const names = toolContracts.get_live_scale_reference.inputSchema.properties.scaleName.enum;
  assert.ok(Array.isArray(names) && names.length > 0);
  for (const scaleName of names) {
    const reply = await route({ id: 1, method: "tools/call", params: {
      name: "get_live_scale_reference", arguments: { scaleName, rootNote: 0 }
    } });
    assert.equal(reply.result?.isError, undefined, scaleName);
    assert.equal(reply.result.structuredContent.scale.name, scaleName);
  }
  const invalid = await route({ id: 2, method: "tools/call", params: {
    name: "get_live_scale_reference", arguments: { scaleName: "not-a-scale", rootNote: 0 }
  } });
  assert.equal(invalid.error?.code, -32602);
});

test("bundled reference results conform to their advertised output schemas", async () => {
  const ajv = new Ajv({ strict: true });
  const route = createRouter(new ToolService({}));
  for (const [name, args] of [
    ["list_live_scales", {}],
    ["get_live_scale_reference", { scaleName: "Major", rootNote: 0 }],
    ["list_producer_chain_blueprints", {}],
    ["get_producer_chain_blueprint", { target: "bass" }],
    ["list_factory_device_profiles", {}]
  ]) {
    assert.ok(toolContracts[name].outputSchema, name);
    const validate = ajv.compile(toolContracts[name].outputSchema);
    const reply = await route({ id: 1, method: "tools/call", params: { name, arguments: args } });
    assert.equal(validate(reply.result.structuredContent), true, `${name}: ${ajv.errorsText(validate.errors)}`);
    assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
  }
});

test("tool output failures are explicit and leave subsequent requests usable", async () => {
  for (const value of [undefined, null, [], "bad", { scales: "bad" },
    { scales: [{ name: "Major", family: "major-mode", intervals: ["0"] }] }]) {
    const route = createRouter({ call: async () => value });
    const reply = await route({ id: 1, method: "tools/call", params: { name: "list_live_scales" } });
    assert.equal(reply.result?.isError, true, JSON.stringify(value));
    assert.equal(reply.result.structuredContent, undefined);
    assert.match(reply.result.content[0].text, /invalid tool result/);
    assert.deepEqual((await route({ id: 2, method: "ping" })).result, {});
  }
  const route = createRouter({ call: async () => { throw new Error("bridge unavailable"); } });
  const reply = await route({ id: 3, method: "tools/call", params: { name: "get_live_state" } });
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, "bridge unavailable");
});

test("every advertised tool declares the extensible object result boundary", async () => {
  for (const tool of (await createRouter({})({ id: 1, method: "tools/list" })).result.tools) {
    assert.equal(tool.outputSchema?.type, "object", tool.name);
  }
  const reply = await createRouter({ call: async () => [] })({ id: 2, method: "tools/call",
    params: { name: "get_live_state" } });
  assert.equal(reply.result?.isError, true);
});
