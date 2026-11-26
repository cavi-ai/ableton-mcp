import { liveOutputContracts } from "./live-output-contracts.mjs";
import { musicOutputContracts } from "./music-output-contracts.mjs";
import { libraryOutputContracts } from "./library-output-contracts.mjs";

// Live readbacks and guarded mutation receipts are extensible objects. Bundled
// references have stable fields that can be validated more specifically.
const result = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required
});
const text = { type: "string" };
const integers = { type: "array", items: { type: "integer" } };
const strings = { type: "array", items: text };
const scale = result({ name: text, family: text, intervals: {
  type: "array", minItems: 1, items: { type: "integer", minimum: 0, maximum: 11 }
} });
const blueprint = result({ id: text, topology: text, summary: text });
const version = { type: "integer", minimum: 1 };
const records = { type: "array", items: { type: "object" } };
export const mutationReceiptSchema = result({ schemaVersion: { const: 1 },
  status: { enum: ["applied", "outcome_unknown", "postconditions_failed", "pending_postconditions", "pending_user_action"] },
  reason: text, evidence: strings });
export const guardedMutationResult = {
  type: "object", required: ["dryRun"], properties: { dryRun: { type: "boolean" } },
  oneOf: [result({ dryRun: { const: true }, plan: { type: "object" }, confirmation: result({
    token: { type: "string", minLength: 1 }, planHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, expiresAt: { type: "number" }
  }) }), result({ dryRun: { const: false }, operationOutcome: mutationReceiptSchema })]
};

// Compact discovery preserves the original reference schemas. Full contracts
// are enforced on every call, independent of the host's discovery profile.
export const compactOutputNames = new Set(["list_live_scales", "get_live_scale_reference", "list_producer_chain_blueprints",
  "get_producer_chain_blueprint", "list_factory_device_profiles"]);

export const toolOutputContracts = {
  answer_live_recovery_prompt: guardedMutationResult,
  cancel_live_export_dialog: guardedMutationResult,
  raise_live: guardedMutationResult,
  get_automation_capabilities: result({ sessionClipParameterEnvelopes: { type: "object" }, sessionClipMixerEnvelopes: { type: "object" },
    arrangementParameterAutomation: { type: "object" }, perNoteProperties: { type: "object" }, perNoteExpressionCurves: { type: "object" },
    productionBoundaries: { type: "object" }, handoffs: records }),
  list_live_scales: result({ scales: { type: "array", items: scale } }),
  get_live_scale_reference: result({ scale: result({ ...scale.properties,
    rootNote: { type: "integer", minimum: 0, maximum: 11 }, rootName: text,
    pitchClasses: integers, noteNames: strings, degrees: integers
  }) }),
  list_producer_chain_blueprints: result({ blueprints: { type: "array", items: blueprint } }),
  get_producer_chain_blueprint: result({ blueprint }),
  list_factory_device_profiles: result({ profiles: { type: "array", items: result({
    id: text, name: text, type: text, family: text, notes: strings, parameterRoles: strings
  }, ["id", "name", "type", "family", "parameterRoles"]) } }),
  ...liveOutputContracts, ...musicOutputContracts, ...libraryOutputContracts
};

export const extensibleToolResult = { type: "object" };
const toolErrorResult = result({ error: result({ message: text, outcome: { enum: ["unknown", "not_executed"] } }) });
export const withToolErrorSchema = schema => schema === extensibleToolResult ? schema : {
  type: "object", anyOf: [schema, toolErrorResult]
};

