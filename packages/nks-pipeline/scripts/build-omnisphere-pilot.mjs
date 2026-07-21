import { readFile, writeFile } from "node:fs/promises";
import { buildOmnispherePilot } from "../src/omnisphere-pilot.mjs";

const manifest = JSON.parse(await readFile("reports/nks/manifest.json", "utf8"));
const records = manifest.records.filter((record) => record.productSlug === "omnisphere");
const pilot = buildOmnispherePilot(records, { size: 25 });
await writeFile("reports/nks/omnisphere-pilot.json", `${JSON.stringify(pilot, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ inventorySize: records.length, pilotSize: pilot.actualSize, coverage: pilot.coverage }));
