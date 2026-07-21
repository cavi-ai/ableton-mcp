import { transitionArtwork } from "./artwork-domain.mjs";

export function approveArtworkSelection(
  records,
  { productSlug, bank = "", reviewer, notes = "Visual and technical gates passed" }
) {
  const decisions = [];
  const updated = records.map((record) => {
    const matches =
      record.productSlug === productSlug &&
      (!bank || record.bank === bank || record.subBank === bank);
    if (!matches || record.state === "approved") return record;
    if (record.state !== "validated") return record;
    const approved = transitionArtwork(record, "approved", {
      reviewer,
      decision: "approved",
      notes
    });
    decisions.push({
      artworkId: approved.id,
      productSlug: approved.productSlug,
      level: approved.level,
      library: approved.library,
      bank: approved.bank,
      subBank: approved.subBank,
      category: approved.category,
      path: approved.path,
      checksum: approved.checksum,
      decision: "approved",
      reviewer,
      notes
    });
    return approved;
  });
  return { records: updated, decisions };
}
