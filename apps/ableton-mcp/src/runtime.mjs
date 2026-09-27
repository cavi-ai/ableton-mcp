import { Catalog } from "../../../packages/nks-pipeline/src/catalog.mjs";
import { UnixBridgeClient } from "./bridge-client.mjs";
import { ToolService } from "./tool-service.mjs";
import { resolveRuntimeConfig } from "./paths.mjs";
import { FileConfirmationStore } from "./confirmation-store.mjs";
import { SnapshotLibrary } from "./snapshot-library.mjs";
import { join } from "node:path";
import { BrowserMetadataLibrary } from "./browser-metadata-library.mjs";

const emptyCatalog = {
  search: () => [],
  get: () => undefined,
  products: () => [],
  getArtwork: () => undefined,
  artworkForPreset: () => undefined,
  metadata: () => { throw new Error("preset catalog is not configured"); },
  planMetadataUpdate: () => { throw new Error("preset catalog is not configured"); },
  setMetadata: () => { throw new Error("preset catalog is not configured"); },
  close: () => {}
};

export function createConfiguredService(environment = process.env, { persistentConfirmations = false } = {}) {
  const { catalogPath, socketPath, confirmationDirectory, snapshotDirectory, browserMetadataPath, spliceRoots } = resolveRuntimeConfig(environment);
  const catalog = catalogPath ? Catalog.open(catalogPath) : emptyCatalog;
  const bridge = new UnixBridgeClient(socketPath);
  const confirmations = persistentConfirmations
    ? new FileConfirmationStore({ directory: confirmationDirectory })
    : undefined;
  let browserLibrary;
  const browserMetadata = () => (browserLibrary ??= new BrowserMetadataLibrary({ path: browserMetadataPath }));
  return {
    service: new ToolService({ bridge, catalog, confirmations, spliceRoots, generationQueuePath: catalogPath,
      snapshotLibrary: new SnapshotLibrary({ directory: snapshotDirectory }),
      deviceChainLibrary: new SnapshotLibrary({ directory: join(snapshotDirectory, "device-chains"),
        formats: ["cavi-device-chain-v1", "cavi-device-chain-v2", "cavi-device-chain-v3", "cavi-device-chain-v4", "cavi-device-chain-v5"] }), browserMetadata }),
    close: () => { browserLibrary?.close(); catalog.close(); }
  };
}
