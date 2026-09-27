import { runPreview } from "../src/preview-runner.mjs";

function parseArgs(argv) {
  const args = { apply: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") args.apply = true;
    else if (flag === "--raw" || flag === "--out") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a path`);
      args[flag === "--raw" ? "rawPath" : "finalPath"] = value;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.rawPath || !args.finalPath) throw new Error("--raw and --out are required");
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = args.apply
    ? { dryRun: false, ...await runPreview(args) }
    : { dryRun: true, rawPath: args.rawPath, finalPath: args.finalPath,
      note: "No audio measured or written. Pass --apply to normalize and validate a captured 12-second WAV." };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
