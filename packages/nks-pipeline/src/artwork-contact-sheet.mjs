import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

function runMagick(args) {
  const result = spawnSync("magick", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ImageMagick failed: ${result.stderr.trim()}`);
}

export function buildContactSheet(
  inputPaths,
  outputPath,
  { columns = 5, tileWidth = 240, tileHeight = 240, gap = 8, background = "#080b14" } = {}
) {
  if (inputPaths.length === 0) throw new Error("contact sheet requires at least one image");
  if (!Number.isInteger(columns) || columns < 1) throw new Error("columns must be positive");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "nks-contact-sheet-"));
  const border = Math.floor(gap / 2);
  const cellWidth = tileWidth + border * 2;
  const cellHeight = tileHeight + border * 2;
  try {
    const tiles = inputPaths.map((inputPath, index) => {
      const tilePath = join(temporaryRoot, `tile-${String(index).padStart(5, "0")}.png`);
      runMagick([
        inputPath,
        "-thumbnail",
        `${tileWidth}x${tileHeight}^`,
        "-gravity",
        "center",
        "-extent",
        `${tileWidth}x${tileHeight}`,
        "-bordercolor",
        background,
        "-border",
        `${border}x${border}`,
        tilePath
      ]);
      return tilePath;
    });
    const fillerPath = join(temporaryRoot, "filler.png");
    runMagick(["-size", `${cellWidth}x${cellHeight}`, `xc:${background}`, fillerPath]);
    const rows = [];
    for (let offset = 0; offset < tiles.length; offset += columns) {
      const rowTiles = tiles.slice(offset, offset + columns);
      while (rowTiles.length < columns) rowTiles.push(fillerPath);
      const rowPath = join(temporaryRoot, `row-${String(rows.length).padStart(5, "0")}.png`);
      runMagick([...rowTiles, "+append", rowPath]);
      rows.push(rowPath);
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    runMagick([...rows, "-append", "-strip", outputPath]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return {
    path: outputPath,
    width: columns * cellWidth,
    height: Math.ceil(inputPaths.length / columns) * cellHeight,
    count: inputPaths.length
  };
}
