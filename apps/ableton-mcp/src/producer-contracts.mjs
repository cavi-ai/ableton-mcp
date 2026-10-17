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
  get_production_context: contract("Read a consistent Live selection and musical context into a private artifact; return a bounded overview and contextRef. No model call.", {}, []),
  run_production_task: contract("Run configured creative and/or functional specialists with bounded private context. Returns an immutable proposal reference, never executes Live changes. Provider use follows explicit server configuration.", {
    goal: string("Requested musical or operational outcome.", 6000), roles: { type: "string", enum: ["creative", "functional", "both"] },
    scope: object({ trackId: string("Exact track ID.", 120), clipId: string("Exact clip ID.", 120), deviceId: string("Exact device ID.", 120) }, []),
    constraints: strings, contextRefs: refs
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
