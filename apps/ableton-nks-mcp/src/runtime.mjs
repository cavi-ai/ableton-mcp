import { Catalog } from "../../../packages/nks-pipeline/src/catalog.mjs";
import { UnixBridgeClient } from "./bridge-client.mjs";
import { ToolService } from "./tool-service.mjs";
import { resolveRuntimeConfig } from "./paths.mjs";

const emptyCatalog = {
  search: () => [],
  get: () => undefined,
  products: () => [],
  getArtwork: () => undefined,
  artworkForPreset: () => undefined,
  close: () => {}
};

export function createConfiguredService(environment = process.env) {
  const { catalogPath, socketPath, kompleteSocketPath } = resolveRuntimeConfig(environment);
  const catalog = catalogPath ? Catalog.open(catalogPath) : emptyCatalog;
  const bridge = new UnixBridgeClient(socketPath);
  const komplete = new UnixBridgeClient(kompleteSocketPath);
  return {
    service: new ToolService({ bridge, catalog, komplete }),
    close: () => catalog.close()
  };
}
