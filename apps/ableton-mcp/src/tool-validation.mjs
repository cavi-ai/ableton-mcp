import Ajv from "ajv";
import { toolContracts } from "./tool-contracts.mjs";
import { guardedMutationResult } from "./tool-output-contracts.mjs";

const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = new Map(Object.entries(toolContracts).map(([name, contract]) => [name, ajv.compile(contract.inputSchema)]));
const resultValidators = new Map(Object.entries(toolContracts).map(([name, contract]) => [name, ajv.compile(contract.outputSchema)]));

export function validateToolArguments(name, args) {
  const validate = validators.get(name);
  if (!validate) throw Object.assign(new Error("unknown tool"), { code: -32602 });
  if (!validate(args)) {
    throw Object.assign(new Error(`invalid tool arguments: ${ajv.errorsText(validate.errors)}`), { code: -32602 });
  }
  return args;
}

export function validateToolResult(name, value, args = {}) {
  const invalid = message => {
    const error = new Error(`invalid tool result: ${message}`);
    const input = toolContracts[name]?.inputSchema.properties;
    if (input?.expectedStateVersion && input.dryRun) Object.assign(error, {
      code: "INVALID_TOOL_RESULT", outcome: "unknown"
    });
    return error;
  };
  const validate = resultValidators.get(name);
  if (!validate || !validate(value)) {
    throw invalid(validate ? ajv.errorsText(validate.errors) : "unknown tool");
  }
  if (toolContracts[name].outputSchema === guardedMutationResult && value.dryRun !== (args.dryRun !== false))
    throw invalid("dryRun does not match the requested execution mode");
  return value;
}
