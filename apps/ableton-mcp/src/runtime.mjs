import { Catalog } from "../../../packages/nks-pipeline/src/catalog.mjs";
import { UnixBridgeClient } from "./bridge-client.mjs";
import { ToolService } from "./tool-service.mjs";
import { resolveRuntimeConfig } from "./paths.mjs";
import { FileConfirmationStore } from "./confirmation-store.mjs";
import { SnapshotLibrary } from "./snapshot-library.mjs";
import { join } from "node:path";
import { BrowserMetadataLibrary } from "./browser-metadata-library.mjs";
import { MacLiveSetHost } from "./live-set-host.mjs";
import { ProducerArtifacts } from "./producer-artifacts.mjs";
import { ProducerService } from "./producer-service.mjs";
import { createProducerRuntime, parseProducerConfig } from "./producer-runtime.mjs";
import { homedir } from "node:os";

const emptyCatalog = {
  configured: false,
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
  const producerConfig = parseProducerConfig(environment);
  const { catalogPath, socketPath, confirmationDirectory, snapshotDirectory, browserMetadataPath, spliceRoots, liveAppPath } = resolveRuntimeConfig(environment);
  const catalog = catalogPath ? Catalog.open(catalogPath) : emptyCatalog;
  const bridge = new UnixBridgeClient(socketPath);
  const confirmations = persistentConfirmations
    ? new FileConfirmationStore({ directory: confirmationDirectory })
    : undefined;
  let browserLibrary;
  const browserMetadata = () => (browserLibrary ??= new BrowserMetadataLibrary({ path: browserMetadataPath }));
  const service = new ToolService({ bridge, catalog, confirmations, spliceRoots, generationQueuePath: catalogPath,
      liveSetHost: new MacLiveSetHost({ appPath: liveAppPath, bridgeSocketPath: socketPath }),
      snapshotLibrary: new SnapshotLibrary({ directory: snapshotDirectory }),
      groupSystemLibrary: new SnapshotLibrary({ directory: join(snapshotDirectory, "group-systems"),
        formats: ["cavi-group-system-v1"] }),
      deviceChainLibrary: new SnapshotLibrary({ directory: join(snapshotDirectory, "device-chains"),
        formats: ["cavi-device-chain-v1", "cavi-device-chain-v2", "cavi-device-chain-v3", "cavi-device-chain-v4", "cavi-device-chain-v5", "cavi-device-chain-v6"] }),
      midiFeelLibrary: new SnapshotLibrary({ directory: join(snapshotDirectory, "midi-feel"),
        formats: ["cavi-midi-feel-v1"] }), browserMetadata });
  return {
    service: createConfiguredProducerService(service, environment, producerConfig),
    close: () => { browserLibrary?.close(); catalog.close(); }
  };
}

export function createConfiguredProducerService(service, environment = process.env, config = parseProducerConfig(environment)) {
  return new ProducerService({ service, config,
    runtimeFactory: runtime => createProducerRuntime(runtime, { environment }),
    artifacts: new ProducerArtifacts(environment.ABLETON_MCP_PRODUCER_DIR || join(homedir(), ".cavi", "ableton-mcp", "producer")) });
}
