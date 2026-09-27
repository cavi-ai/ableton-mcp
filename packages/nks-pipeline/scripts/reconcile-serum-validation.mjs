import { isAbsolute } from "node:path";
import { reconcileSerumValidation } from "../src/serum-validation.mjs";

const fields = new Map([["--manifest", "manifestPath"], ["--catalog", "catalogPath"],
  ["--preset-id", "presetId"], ["--report", "reportPath"]]);

function parse(argv) {
  const input = { apply: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") { input.apply = true; continue; }
    const field = fields.get(flag);
    if (!field || !argv[index + 1] || argv[index + 1].startsWith("--"))
      throw new Error(`unknown or incomplete option ${flag}`);
    input[field] = argv[++index];
  }
  for (const field of ["manifestPath", "catalogPath", "reportPath"])
    if (!isAbsolute(input[field] || "")) throw new Error(`${field} requires an absolute path`);
  if (!input.presetId) throw new Error("presetId is required");
  return input;
}

try {
  console.log(JSON.stringify(await reconcileSerumValidation(parse(process.argv.slice(2)))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
