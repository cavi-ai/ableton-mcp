import { readFile, writeFile } from "node:fs/promises";
import { buildSerumPilot } from "../src/serum-pilot.mjs";

const [manifestPath = "reports/nks/manifest.json", outputPath = "reports/nks/serum-pilot.json"] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const records = manifest.records.filter((record) => record.productSlug === "serum-2");
const pilot = buildSerumPilot(records, { requestedSize: 25 });
await writeFile(outputPath, `${JSON.stringify(pilot, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, inventorySize: records.length, pilotSize: pilot.actualSize, coverage: pilot.coverage }));
