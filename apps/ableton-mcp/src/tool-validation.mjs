import Ajv from "ajv";
import { toolContracts } from "./tool-contracts.mjs";

const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = new Map(Object.entries(toolContracts).map(([name, contract]) => [name, ajv.compile(contract.inputSchema)]));

export function validateToolArguments(name, args) {
  const validate = validators.get(name);
  if (!validate) throw Object.assign(new Error("unknown tool"), { code: -32602 });
  if (!validate(args)) {
    throw Object.assign(new Error(`invalid tool arguments: ${ajv.errorsText(validate.errors)}`), { code: -32602 });
  }
  return args;
}
