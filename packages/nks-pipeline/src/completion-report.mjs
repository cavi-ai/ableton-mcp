export function calculateCompletion({
  productSlugs,
  manifestRecords,
  sourceComplete,
  browserInventories,
  nksValidIds,
  artworkAssignments,
  approvedArtworkIds
}) {
  const products = {};
  for (const productSlug of productSlugs) {
    const sourceIds = manifestRecords
      .filter((record) => record.productSlug === productSlug)
      .map((record) => record.id)
      .sort();
    const sourceSet = new Set(sourceIds);
    const browserIds = [...new Set(browserInventories[productSlug] || [])]
      .filter((id) => sourceSet.has(id))
      .sort();
    const nksCount = sourceIds.filter((id) => nksValidIds.has(id)).length;
    const artworkCount = sourceIds.filter((id) => {
      const artworkId = artworkAssignments.get(id);
      return artworkId && approvedArtworkIds.has(artworkId);
    }).length;
    const flags = {
      sourceComplete: sourceComplete[productSlug] === true && sourceIds.length > 0,
      browserComplete:
        sourceIds.length > 0 &&
        browserIds.length === sourceIds.length &&
        browserIds.every((id) => sourceSet.has(id)),
      nksComplete: sourceIds.length > 0 && nksCount === sourceIds.length,
      artworkComplete: sourceIds.length > 0 && artworkCount === sourceIds.length
    };
    const blockers = [];
    if (!flags.sourceComplete) blockers.push("SOURCE_INVENTORY_INCOMPLETE");
    if (!flags.browserComplete) {
      blockers.push(
        productSlug === "vps-avenger"
          ? "AVENGER_BROWSER_INVENTORY_MISSING"
          : "BROWSER_INVENTORY_INCOMPLETE"
      );
    }
    if (!flags.nksComplete) blockers.push("NKS_RECORDS_INCOMPLETE");
    if (!flags.artworkComplete) blockers.push("ARTWORK_ASSIGNMENTS_INCOMPLETE");
    products[productSlug] = {
      ...flags,
      fullyComplete: Object.values(flags).every(Boolean),
      counts: {
        source: sourceIds.length,
        browserReconciled: browserIds.length,
        nksValid: nksCount,
        artworkAssigned: artworkCount
      },
      blockers
    };
  }
  return {
    version: 1,
    products,
    combined: {
      fullyComplete: productSlugs.every((slug) => products[slug].fullyComplete),
      blockers: [...new Set(productSlugs.flatMap((slug) => products[slug].blockers))]
    }
  };
}
