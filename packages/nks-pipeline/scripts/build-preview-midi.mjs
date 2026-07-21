import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildSerumPreviewMidi } from "../src/preview-midi.mjs";

const outputPath = process.argv[2] ?? "ableton/preview/serum-preview.mid";
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, buildSerumPreviewMidi());
console.log(outputPath);
