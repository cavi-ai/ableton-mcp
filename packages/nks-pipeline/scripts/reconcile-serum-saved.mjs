import { isAbsolute } from "node:path";
import { reconcileSerumSaved } from "../src/serum-saved-reconciliation.mjs";

const names = new Map([
  ["--manifest", "manifestPath"], ["--catalog", "catalogPath"],
  ["--run-log", "runLogPath"], ["--browser-db", "browserPath"],
  ["--user-content-root", "userContentRoot"]
]);

function parse(args) {
  const input = { apply: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--apply") { input.apply = true; continue; }
    const key = names.get(flag);
    if (!key || !args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error(`unknown or incomplete option ${flag}`);
    input[key] = args[++index];
  }
  for (const key of names.values()) {
    if (!input[key] || !isAbsolute(input[key])) throw new Error(`${key} requires an absolute path`);
  }
  return input;
}

try {
  console.log(JSON.stringify(await reconcileSerumSaved(parse(process.argv.slice(2)))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
