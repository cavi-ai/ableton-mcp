import { createPresetRecord, stablePresetId } from "./domain.mjs";

export async function inventoryProduct({
  discover,
  store,
  catalog,
  idForDiscovery = stablePresetId
}) {
  let discovered = 0;
  let unchanged = 0;
  for (const discovery of await discover()) {
    const id = idForDiscovery(discovery);
    const existing = store.get(id);
    let record;
    if (existing?.sourceFingerprint === discovery.sourceFingerprint) {
      record = {
        ...existing,
        ...(discovery.sourceContainerPath && { sourceContainerPath: discovery.sourceContainerPath }),
        ...(discovery.sourceEntryName && { sourceEntryName: discovery.sourceEntryName })
      };
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
  await store.flush();
  return { discovered, unchanged };
}
