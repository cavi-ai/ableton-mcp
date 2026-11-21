import Ajv from "ajv";
import { discoveryArguments } from "./production-tool-catalog.mjs";

const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string", maxLength: 2000 };
const call = object({ tool: { type: "string", minLength: 1, maxLength: 100 }, args: { type: "object" } });
const list = (items, maxItems = 8) => ({ type: "array", items, maxItems });
export const producerResponseSchema = object({
  summary: { ...text, minLength: 1 }, reads: list(call, 4), operations: list(call, 16),
  checks: list(object({ ...call.properties, path: list({ anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }] }), expected: {} })),
  questions: list(text), alternatives: list(object({ name: text, description: text }), 4)
});
const ajv = new Ajv({ strict: true });
const validateResponse = ajv.compile(producerResponseSchema);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const budget = { reads: 8, discoveries: 8 };

export const turnLimit = deferred => deferred ? 6 : 3;
export const lastTurn = progress => progress?.turn >= progress?.maxTurns;
export const turnProgress = ({ round, deferred, reads, discoveries }) => ({ turn: round + 1, maxTurns: turnLimit(deferred),
  readsRemaining: budget.reads - reads, ...(deferred ? { discoveriesRemaining: budget.discoveries - discoveries } : {}) });

export function turnOutcome(reply, progress) {
  if (!reply.reads.length) return { next: "finish" };
  const discoveries = progress.discoveriesRemaining === undefined ? 0 : reply.reads.filter(read => read.tool === "discover_production_tools").length;
  const stopReason = lastTurn(progress) ? "model_turn_limit" : reply.reads.length - discoveries > progress.readsRemaining ? "read_limit"
    : discoveries > (progress.discoveriesRemaining ?? 0) ? "discovery_limit" : null;
  return stopReason ? { next: "stop", stopReason } : { next: "read" };
}

export function parseProducerResponse(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16000) throw new Error("specialist output limit exceeded");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("specialist must return a JSON object"); }
  if (!validateResponse(value)) throw new Error(`specialist output schema mismatch: ${ajv.errorsText(validateResponse.errors)}`);
  for (const operation of value.operations) {
    if (["dryRun", "confirmationToken", "planHash", "expectedStateVersion"].some(key => Object.hasOwn(operation.args, key)))
      throw new Error("specialists cannot supply execution or confirmation fields");
  }
  return value;
}

function embedSchema(value, pointer) {
  if (Array.isArray(value)) return value.map(item => embedSchema(item, pointer));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === "$ref" && typeof item === "string" && (item === "#" || item.startsWith("#/"))
      ? pointer + item.slice(1) : embedSchema(item, pointer)]));
}

function callSchemas(tools, field, extra = {}) {
  return { anyOf: tools.map((tool, index) => object({ tool: { type: "string", const: tool.name },
    args: embedSchema(tool.inputSchema, `#/properties/${field}/items/anyOf/${index}/properties/args`),
    ...structuredClone(extra) })) };
}

export function responseFormat(packet) {
  const schema = structuredClone(producerResponseSchema);
  const canChange = packet.role === "functional" && packet.intent !== "inspect";
  const operations = canChange ? packet.tools?.operations || [] : [];
  // Replace the operation item rather than mutating the call shared by reads/checks.
  if (operations.length) schema.properties.operations.items = callSchemas(operations, "operations");
  else schema.properties.operations.maxItems = 0;
  if (Array.isArray(packet.tools?.reads)) {
    const reads = packet.tools.reads;
    schema.properties.reads.items = callSchemas([...reads,
      { name: "discover_production_tools", annotations: readOnly, inputSchema: { ...discoveryArguments, properties: {
        ...discoveryArguments.properties, kind: { ...discoveryArguments.properties.kind, enum: canChange ? ["read", "operation"] : ["read"] } } } },
      { name: "read_production_artifact", annotations: readOnly,
        inputSchema: object({
        artifactId: { type: "string", pattern: "^[a-f0-9]{64}$" },
        offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 8000 }
      }, ["artifactId"]) }
    ], "reads");
    if (packet.role === "functional" && reads.length) schema.properties.checks.items = callSchemas(reads, "checks", {
      path: producerResponseSchema.properties.checks.items.properties.path, expected: {}
    });
    else schema.properties.checks.maxItems = 0;
  }
  if (lastTurn(packet.progress)) schema.properties.reads.maxItems = 0;
  return schema;
}
