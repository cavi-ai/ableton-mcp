import { join, resolve } from "node:path";

const products = {
  "serum-2": "Serum 2",
  omnisphere: "Omnisphere",
  "vps-avenger": "VPS Avenger"
};

const safe = (value) => value.normalize("NFC").replace(/[\\/:*?"<>|]/g, "_").trim();

export function planArtifactPaths(record, outputRoot) {
  const root = resolve(outputRoot);
  const product = products[record.productSlug];
  if (!product) throw new Error(`unsupported product ${record.productSlug}`);
  const stem = safe(`${record.name}__${record.id.split(":").at(-1)}`);
  const nksPath = resolve(
    join(root, "User Content", product, safe(record.bank), safe(record.subBank), `${stem}.nksf`)
  );
  const previewPath = resolve(
    join(root, "Previews", product, safe(record.bank), safe(record.subBank), `${stem}.wav`)
  );
  if (!nksPath.startsWith(`${root}/`) || !previewPath.startsWith(`${root}/`)) {
    throw new Error("artifact path escaped output root");
  }
  return Object.freeze({ nksPath, previewPath });
}
