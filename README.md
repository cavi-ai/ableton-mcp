# Ableton NKS MCP

Local-first tooling for cataloging NKS presets and controlling Ableton Live through an MCP server and a small Ableton Remote Script bridge.

## Repository layout

- `apps/ableton-nks-mcp` — MCP server and tests
- `packages/nks-pipeline` — preset inventory, catalog, artwork, preview, and generation helpers
- `ableton/Remote Scripts/CaviMcpBridge` — Ableton Live bridge
- `config` — product and artwork configuration
- `examples/artwork` — redistributable generic artwork for exercising the renderer
- `schemas` — manifest schemas

Generated presets, artwork, catalogs, and factory-source files are not part of this repository.

## Artwork model

The repository does not scrape or auto-populate vendor artwork. Operators provide an authoritative master image and metadata; the pipeline deterministically renders Native Instruments product, bank, category, and size variants. Generated derivatives and installation staging remain build outputs rather than source-controlled assets.

`examples/artwork/generic-synth-master.png` is an original, vendor-neutral fixture for documentation and renderer tests. Its provenance is recorded beside it. Product-specific masters are not part of this repository.

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

Code and the generic example artwork are distributed under the repository's MIT license. Third-party product names belong to their respective owners. No vendor artwork, logos, presets, or implied endorsements are included.
