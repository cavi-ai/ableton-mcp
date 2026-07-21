import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { symbolSvg } from "./artwork-symbols.mjs";
import { validateArtwork } from "./artwork-validation.mjs";

function runMagick(args) {
  const result = spawnSync("magick", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ImageMagick failed: ${result.stderr.trim()}`);
}

function bankModulation(artworkId) {
  const digest = createHash("sha256").update(artworkId).digest();
  return {
    brightness: 92 + (digest[0] % 13),
    saturation: 92 + (digest[1] % 21),
    hue: 96 + (digest[2] % 9)
  };
}

export function renderBankArtwork({ inputPath, outputPath, artworkId }) {
  const modulation = bankModulation(artworkId);
  mkdirSync(dirname(outputPath), { recursive: true });
  runMagick([
    inputPath,
    "-auto-orient",
    "-resize",
    "1254x1254^",
    "-gravity",
    "center",
    "-extent",
    "1254x1254",
    "-modulate",
    `${modulation.brightness},${modulation.saturation},${modulation.hue}`,
    "-strip",
    outputPath
  ]);
  return validateArtwork(outputPath, { format: "PNG", minWidth: 1254, minHeight: 1254 });
}

export function renderCategoryVariant({ inputPath, outputPath, symbol, accent }) {
  const directory = mkdtempSync(join(tmpdir(), "nks-symbol-"));
  const symbolPath = join(directory, "symbol.svg");
  writeFileSync(symbolPath, symbolSvg(symbol, accent));
  mkdirSync(dirname(outputPath), { recursive: true });
  runMagick([
    inputPath,
    "-fill",
    accent,
    "-colorize",
    "4",
    "(",
    "-background",
    "none",
    symbolPath,
    "-resize",
    "128x128",
    ")",
    "-gravity",
    "southeast",
    "-geometry",
    "+70+70",
    "-composite",
    "-strip",
    outputPath
  ]);
  return validateArtwork(outputPath, { format: "PNG", minWidth: 1254, minHeight: 1254 });
}

export function renderDerivatives({ inputPath, outputRoot, policy }) {
  const results = [];
  for (const output of policy.outputs) {
    const path = join(outputRoot, output.filename);
    mkdirSync(dirname(path), { recursive: true });
    runMagick([
      inputPath,
      "-auto-orient",
      "-resize",
      `${output.width}x${output.height}^`,
      "-gravity",
      "center",
      "-extent",
      `${output.width}x${output.height}`,
      "-strip",
      path
    ]);
    const validation = validateArtwork(path, {
      format: output.format,
      minWidth: output.width,
      minHeight: output.height
    });
    if (validation.width !== output.width || validation.height !== output.height) {
      throw new Error(`incorrect derivative dimensions for ${output.name}`);
    }
    results.push({ name: output.name, path, ...validation });
  }
  return results;
}
