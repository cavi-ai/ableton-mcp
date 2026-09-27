import { createPresetRecord, stablePresetId } from "./domain.mjs";

export async function inventoryProduct({
  productSlug,
  discover,
  store,
  catalog,
  idForDiscovery = stablePresetId
}) {
  if (!productSlug) throw new Error("productSlug is required");
  const identified = (await discover()).map((discovery) => ({ discovery, id: idForDiscovery(discovery) }));
  const ids = new Set();
  for (const { id } of identified) {
    if (ids.has(id)) throw new Error(`duplicate preset ID ${id}`);
    ids.add(id);
  }
  let discovered = 0;
  let unchanged = 0;
  const seen = new Set();
  for (const { discovery, id } of identified) {
    seen.add(id);
    const existing = store.get(id);
    let record;
    if (existing?.sourceFingerprint === discovery.sourceFingerprint) {
      const { missing: _missing, sourceContainerPath: _container, sourceEntryName: _entry,
        ...present } = existing;
      const { state: _state, attempts: _attempts, evidence: _evidence,
        ...sourceMetadata } = createPresetRecord(discovery);
      record = { ...present, ...sourceMetadata, id };
      unchanged += 1;
    } else {
      record = { ...createPresetRecord(discovery), id };
      if (existing) {
        record = {
          ...record,
          evidence: [
            {
              state: "discovered",
              reason: "source_changed",
              previousFingerprint: existing.sourceFingerprint
            }
          ]
        };
      }
      discovered += 1;
    }
    await store.upsert(record);
    catalog.upsert(record);
  }
  let missing = 0;
  for (const record of store.list(productSlug)) {
    if (seen.has(record.id)) continue;
    const flagged = { ...record, missing: true };
    await store.upsert(flagged);
    catalog.upsert(flagged);
    missing += 1;
  }
  await store.flush();
  return { discovered, unchanged, missing };
}
