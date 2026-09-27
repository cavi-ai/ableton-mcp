import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildOmnispherePilot } from "../src/omnisphere-pilot.mjs";

function parseArgs(argv) {
  const args = { manifestPath: "reports/nks/manifest.json",
    outputPath: "reports/nks/omnisphere-pilot.json", apply: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") args.apply = true;
    else if (flag === "--manifest" || flag === "--out") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a path`);
      args[flag === "--manifest" ? "manifestPath" : "outputPath"] = value;
    } else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(args.manifestPath, "utf8"));
  const pilot = buildOmnispherePilot(manifest.records);
  if (args.apply) {
    await mkdir(dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(pilot, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ dryRun: !args.apply, outputPath: args.outputPath,
    inventorySize: manifest.records.length, pilotSize: pilot.actualSize,
    readiness: pilot.readiness, coverage: pilot.coverage })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
