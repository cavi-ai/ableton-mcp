import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function validateArtwork(
  path,
  { format = "PNG", minWidth = 1024, minHeight = 1024 } = {}
) {
  if (!existsSync(path)) throw new Error(`artwork file does not exist: ${path}`);
  const identified = spawnSync(
    "magick",
    ["identify", "-format", "%m %w %h", path],
    { encoding: "utf8" }
  );
  if (identified.status !== 0) {
    throw new Error(`unable to identify artwork: ${identified.stderr.trim() || path}`);
  }
  const [actualFormat, widthText, heightText] = identified.stdout.trim().split(/\s+/);
  const width = Number(widthText);
  const height = Number(heightText);
  if (actualFormat !== format) {
    throw new Error(`artwork format ${actualFormat} does not match ${format}`);
  }
  if (width < minWidth || height < minHeight) {
    throw new Error(
      `artwork dimensions ${width}x${height} are below ${minWidth}x${minHeight}`
    );
  }
  const checksum = `sha256:${createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")}`;
  return Object.freeze({ format: actualFormat, width, height, checksum });
}
