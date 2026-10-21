import test from "node:test";
import assert from "node:assert/strict";
import { getProductionCapabilities, productionBoundaries } from "../src/production-capabilities.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";

test("implementation capabilities retain honest boundaries without requiring Live", async () => {
  const service = new ToolService({ bridge: { request: async () => { throw Error("unexpected native request"); } } });
  const result = await createRouter(service)({ id: 1, method: "tools/call", params: { name: "get_automation_capabilities" } });
  assert.equal(result.result.isError, undefined);
  const value = result.result.structuredContent;
  assert.equal(value.arrangementParameterAutomation.write, false);
  assert.equal(value.sessionClipParameterEnvelopes.shape, "steps");
  assert.equal(value.perNoteExpressionCurves.read, false);
  assert.deepEqual(value.productionBoundaries, productionBoundaries);
  assert.equal(value.handoffs.length, 5);
});

test("capability callers cannot mutate subsequent observations", () => {
  const first = getProductionCapabilities();
  first.productionBoundaries.automaticAudibleQualityVerification = true;
  first.sessionClipMixerEnvelopes.controls.length = 0;
  first.handoffs.length = 0;
  const second = getProductionCapabilities();
  assert.equal(second.productionBoundaries.automaticAudibleQualityVerification, false);
  assert.equal(second.sessionClipMixerEnvelopes.controls.length, 3);
  assert.equal(second.handoffs.length, 5);
});
