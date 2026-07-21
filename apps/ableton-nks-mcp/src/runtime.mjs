import { Catalog } from "../../../packages/nks-pipeline/src/catalog.mjs";
import { UnixBridgeClient } from "./bridge-client.mjs";
import { ToolService } from "./tool-service.mjs";

export function createConfiguredService(environment = process.env) {
  const catalogPath = environment.ABLETON_NKS_CATALOG_PATH;
  const socketPath = environment.CAVI_MCP_BRIDGE_SOCKET;
  if (!catalogPath) throw new Error("ABLETON_NKS_CATALOG_PATH is required");
  if (!socketPath) throw new Error("CAVI_MCP_BRIDGE_SOCKET is required");
  const catalog = Catalog.open(catalogPath);
  const bridge = new UnixBridgeClient(socketPath);
  return {
    service: new ToolService({ bridge, catalog }),
    close: () => catalog.close()
  };
}
