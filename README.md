# Ableton MCP

Local-first Ableton Live control through an installable Remote Script, MCP server, and command-line interface. NKS catalog integration is optional.

## Repository layout

- `apps/ableton-nks-mcp` — MCP server, CLI, and tests
- `packages/nks-pipeline` — preset inventory, catalog, artwork, preview, and generation helpers
- `ableton/Remote Scripts/CaviMcpBridge` — Ableton Live bridge
- `config` — product and artwork configuration
- `examples/artwork` — redistributable generic artwork for exercising the renderer
- `schemas` — manifest schemas

Generated presets, artwork, catalogs, and factory-source files are not part of this repository.

## Control surface

Read operations expose Live status, tracks, scenes, clips, devices, device parameters, complete track mixer state with named return sends, Session clip envelopes, extended MIDI note properties, and optional NKS catalog search. Guarded mutations cover transport play/stop, tempo, track volume/pan/mute/solo/arm and return sends, scene and clip launch, clip stop, device parameters, Session clip envelope steps, per-note MIDI properties, and panic. Every mutation requires an observed state version, defaults to a dry-run plan, and uses a short-lived single-use confirmation token for execution.

`get_automation_capabilities` reports the exact supported surface. Ableton Live 12.4.5 exposes Session clip parameter envelopes and the per-note fields pitch, start, duration, velocity, velocity deviation, release velocity, probability, and mute. Its public API does not expose Arrangement automation envelopes or per-note pitch-bend, pressure, and slide curves; the MCP reports those boundaries instead of simulating unsupported writes.

## Artwork model

The repository does not scrape or auto-populate vendor artwork. Operators provide an authoritative master image and metadata; the pipeline deterministically renders Native Instruments product, bank, category, and size variants. Generated derivatives and installation staging remain build outputs rather than source-controlled assets.

`examples/artwork/generic-synth-master.png` is an original, vendor-neutral fixture for documentation and renderer tests. Its provenance is recorded beside it. Product-specific masters are not part of this repository.

## Requirements

- Node.js 22 or newer
- Python 3 for bridge tests
- Ableton Live for live integration
- ImageMagick for artwork rendering

## Development

```bash
npm test
```

## CLI

```bash
npm run cli -- help
npm run cli -- install
npm run cli -- doctor --json
npm run cli -- serve
npm run cli -- status --json
npm run cli -- resource ableton://set/tracks --json
npm run cli -- call list_devices --args '{"trackId":"track-0"}' --json
```

`install` copies only `CaviMcpBridge` into the user-level Ableton Remote Scripts directory. It does not modify Ableton application bundles. Enable **CaviMcpBridge** as a Control Surface in Ableton Live preferences after installation.

Use `ableton-mcp uninstall` to remove only that installed script directory. Pass `--destination <Remote Scripts path>` when the Ableton User Library is in a non-default location.

The default bridge socket is `${TMPDIR}/cavi-ableton-mcp.sock`. Override it with `CAVI_MCP_BRIDGE_SOCKET` when needed.

Run the MCP server in fixture mode:

```bash
ABLETON_NKS_MCP_FIXTURE=1 npm start
```

Set `ABLETON_NKS_CATALOG_PATH` only when local preset search is wanted. Without it, preset search returns an empty collection.

## Safety

Mutating Ableton operations use plan hashes and short-lived, single-use confirmation tokens. Keep generated commercial preset content out of this repository.

## License

Code and the generic example artwork are distributed under the repository's MIT license. Third-party product names belong to their respective owners. No vendor artwork, logos, presets, or implied endorsements are included.
