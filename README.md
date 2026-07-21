# Ableton NKS MCP

Local-first tooling for cataloging NKS presets and controlling Ableton Live through an MCP server and a small Ableton Remote Script bridge.

## Repository layout

- `apps/ableton-nks-mcp` — MCP server and tests
- `packages/nks-pipeline` — preset inventory, catalog, artwork, preview, and generation helpers
- `ableton/Remote Scripts/CaviMcpBridge` — Ableton Live bridge
- `config` — product and artwork configuration
- `schemas` — manifest schemas

Generated presets, artwork, catalogs, and factory-source files are not part of this repository.

## Requirements

- Node.js 20 or newer
- Python 3 for bridge tests
- Ableton Live for live integration
- ImageMagick for artwork rendering

## Development

```bash
npm test
```

Run the MCP server in fixture mode:

```bash
ABLETON_NKS_MCP_FIXTURE=1 npm start
```

For live use, set `ABLETON_NKS_CATALOG_PATH` to the private catalog database and `CAVI_MCP_BRIDGE_SOCKET` to the Ableton bridge socket.

## Safety

Mutating Ableton operations use plan hashes and short-lived, single-use confirmation tokens. Keep generated commercial preset content out of this repository.

## License

MIT. Third-party product names belong to their respective owners.
