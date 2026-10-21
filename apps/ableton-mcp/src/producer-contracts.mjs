import { producerOutputContracts } from "./tool-output-contracts.mjs";

const string = (description, maxLength = 2000) => ({ type: "string", minLength: 1, maxLength, description });
const projectId = { ...string("Private project namespace.", 80), pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" };
const artifact = { ...string("Artifact ID returned by a producer tool.", 64), pattern: "^[a-f0-9]{64}$" };
const strings = { type: "array", items: string("Explicit user constraint."), maxItems: 12 };
const refs = { type: "array", items: artifact, maxItems: 8, uniqueItems: true };
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const contract = (description, properties, required, readOnlyHint = true) => ({ description,
  inputSchema: object({ projectId, ...properties }, ["projectId", ...required]),
  outputSchema: { type: "object", additionalProperties: true },
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: true } });

export const producerToolContracts = {
  get_production_context: contract("Capture consistent Live selection and musical context in a persistent private artifact; return a bounded overview and contextRef. No model call or Live edit.", {}, [], false),
  run_production_task: contract("Run configured creative and/or functional specialists with bounded private context. Returns an immutable proposal reference, never executes Live changes. Optional caller postconditions define required final field checks. Provider use follows explicit server configuration.", {
    goal: string("Requested musical or operational outcome.", 6000), roles: { type: "string", enum: ["creative", "functional", "both"] },
    intent: { type: "string", enum: ["change", "inspect"], description: "change (default) requires operations or fresh caller criteria proving no change is needed. inspect permits observations without operation proposals." },
    scope: object({ trackId: string("Exact ordinary/Group track-N, Return return-N or Main master owner.", 120), clipId: string("Exact clip ID on an ordinary track.", 120), deviceId: string("Exact device ID owned by trackId.", 120) }, []),
    constraints: strings, contextRefs: refs,
    postconditions: { type: "array", minItems: 1, maxItems: 8,
      description: "Optional caller-owned required final field checks. Specialist checks remain suggestions when supplied.",
      items: object({ tool: string("Exact read-only tool name.", 100), args: { type: "object" },
        path: { type: "array", maxItems: 8, items: { anyOf: [{ type: "string", maxLength: 120 }, { type: "integer", minimum: 0 }] } },
        expected: {} }, ["tool", "args", "path", "expected"]) },
    workflow: object({ name: string("Exact name from get_producer_workflow.", 100),
      arguments: { type: "object", maxProperties: 8, propertyNames: { minLength: 1, maxLength: 64 },
        additionalProperties: { type: "string", maxLength: 8192 } } }, ["name"])
  }, ["goal"], false),
  read_production_artifact: contract("Read a bounded page of one private project artifact. Follow nextOffset for more detail; truncated pages are not complete evidence.", {
    artifactId: artifact, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 8000 }
  }, ["artifactId"]),
  record_production_note: contract("Store explicit user intent or feedback as a private immutable artifact. Supply its noteRef in later task contextRefs to reuse it.", {
    kind: { type: "string", enum: ["intent", "feedback"] }, text: string("User intent or feedback; do not label preferences as observed Live facts.", 6000), contextRefs: refs
  }, ["kind", "text"], false),
  apply_production_operation: contract("Plan one proposed operation through its original tool, or execute using that exact plan's confirmation. Requires unchanged task state; later operations require the preceding applied receipt. Returns bounded result references and observed postconditions, not an audible judgment.", {
    taskId: artifact, operationIndex: { type: "integer", minimum: 0, maximum: 15 }, previousReceiptId: artifact,
    expectedStateVersion: { type: "integer", minimum: 1 }, dryRun: { type: "boolean" },
    confirmationToken: string("Original tool's single-use confirmation token."), planHash: string("Original tool's plan hash.")
  }, ["taskId", "operationIndex", "expectedStateVersion"], false)
};
producerToolContracts.apply_production_operation.annotations.destructiveHint = true;

const sessionId = { ...string("Durable session ID returned by start_production_session.", 36), pattern: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$" };
const taskProperties = producerToolContracts.run_production_task.inputSchema.properties;
producerToolContracts.start_production_session = contract("Capture a durable production brief and current Set identity. Starts at inspect; does not call a model or change Live. Keep the returned sessionId for later conversations.",
  { ...Object.fromEntries(["goal", "scope", "constraints", "postconditions", "workflow"].map(key => [key, taskProperties[key]])),
    roles: { type: "string", enum: ["both", "functional"], description: "both (default) chooses a creative alternative before functional work; functional proposes the operational task directly." },
    completion: { type: "string", enum: ["listening", "postconditions"], description: "listening (default) requires actual user feedback and a decision. postconditions requires nonempty caller criteria and can finish from their fresh field checks without claiming user approval or audible quality." }
  }, ["goal"], false);
producerToolContracts.get_production_session = contract("Read a bounded durable session summary, or list up to twenty sessions in this project when sessionId is omitted. Does not refresh Live; use advance action resume before continuing.",
  { sessionId, offset: { type: "integer", minimum: 0 } }, []);
producerToolContracts.advance_production_session = contract("Advance one durable session phase with optimistic revision checks. propose runs a bounded specialist; choose selects a saved creative alternative; apply retains original dry-run and confirmation guards. resume inspects fresh state and preserves uncertain or partially failed execution. replan explicitly starts a new proposal from that inspection and its saved ledger. evaluate uses listening or caller-postcondition completion. Interrupted execution is never replayed.", {
  sessionId, expectedRevision: { type: "integer", minimum: 1 },
  action: { type: "string", enum: ["resume", "replan", "propose", "choose", "apply", "feedback", "evaluate"] },
  alternativeIndex: { type: "integer", minimum: 0, maximum: 3 },
  text: string("Explicit user listening feedback; not an observed Live fact.", 6000),
  decision: { type: "string", enum: ["accept", "revise"] },
  ...Object.fromEntries(["expectedStateVersion", "dryRun", "confirmationToken", "planHash"].map(key => [key, producerToolContracts.apply_production_operation.inputSchema.properties[key]]))
}, ["sessionId", "expectedRevision", "action"], false);
producerToolContracts.advance_production_session.annotations.destructiveHint = true;
for (const name of ["get_production_context", "read_production_artifact", "record_production_note", "start_production_session", "get_production_session"])
  producerToolContracts[name].annotations.openWorldHint = false;
// Notes are content-addressed: repeating the same note creates no additional artifact.
producerToolContracts.record_production_note.annotations.idempotentHint = true;
for (const [name, outputSchema] of Object.entries(producerOutputContracts)) producerToolContracts[name].outputSchema = outputSchema;
