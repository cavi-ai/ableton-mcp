import Ajv from "ajv";
import { toolContracts } from "./tool-contracts.mjs";
import { guardedMutationResult } from "./tool-output-contracts.mjs";

const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = new Map();
const resultValidators = new Map();

function validator(name, field, cache) {
  const contract = toolContracts[name];
  if (!contract) return undefined;
  if (!cache.has(name)) cache.set(name, ajv.compile(contract[field]));
  return cache.get(name);
}

export function validateToolArguments(name, args) {
  const validate = validator(name, "inputSchema", validators);
  if (!validate) throw Object.assign(new Error("unknown tool"), { code: -32602 });
  if (!validate(args)) {
    throw Object.assign(new Error(`invalid tool arguments: ${ajv.errorsText(validate.errors)}`), { code: -32602 });
  }
  return args;
}

export function validateToolResult(name, value, args = {}) {
  const invalid = message => {
    const error = new Error(`invalid tool result: ${message}`);
    if (toolContracts[name]?.annotations.readOnlyHint === false) Object.assign(error, {
      code: "INVALID_TOOL_RESULT", outcome: "unknown"
    });
    return error;
  };
  const validate = validator(name, "outputSchema", resultValidators);
  if (!validate || !validate(value)) {
    throw invalid(validate ? ajv.errorsText(validate.errors) : "unknown tool");
  }
  if ((toolContracts[name].outputSchema === guardedMutationResult ||
      (toolContracts[name].inputSchema.properties.dryRun && Object.hasOwn(value, "dryRun"))) &&
      value.dryRun !== (args.dryRun !== false))
    throw invalid("dryRun does not match the requested execution mode");
  return value;
}
