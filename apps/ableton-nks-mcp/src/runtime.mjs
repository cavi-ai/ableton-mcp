import { Catalog } from "../../../packages/nks-pipeline/src/catalog.mjs";
import { UnixBridgeClient } from "./bridge-client.mjs";
import { ToolService } from "./tool-service.mjs";
import { resolveRuntimeConfig } from "./paths.mjs";
import { FileConfirmationStore } from "./confirmation-store.mjs";

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
  const { catalogPath, socketPath, kompleteSocketPath, confirmationDirectory } = resolveRuntimeConfig(environment);
  const catalog = catalogPath ? Catalog.open(catalogPath) : emptyCatalog;
  const bridge = new UnixBridgeClient(socketPath);
  const komplete = new UnixBridgeClient(kompleteSocketPath);
  const confirmations = persistentConfirmations
    ? new FileConfirmationStore({ directory: confirmationDirectory })
    : undefined;
  return {
    service: new ToolService({ bridge, catalog, komplete, confirmations }),
    close: () => catalog.close()
  };
}
