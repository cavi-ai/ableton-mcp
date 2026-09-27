import { extname } from "node:path";

export function serumNksName(record) {
  const extension = extname(record.sourceRelativePath);
  const withoutExtension = extension
    ? record.sourceRelativePath.slice(0, -extension.length) : record.sourceRelativePath;
  const safePath = withoutExtension.split("/")
    .map(part => part.replace(/[<>:"\\|?*\u0000-\u001f]/g, "-").trim()).join(" - ");
  return `CAVI Serum2 - ${safePath} - ${record.id.split(":").at(-1).slice(0, 8)}`;
}
