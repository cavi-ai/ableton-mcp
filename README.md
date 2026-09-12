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

Read operations expose Live status, playhead, transport-recording, metronome, and count-in context, song key/scale and timing context, global and recording quantization, groove pool and swing state, Arrangement loop and cue-point state, tracks, scenes, clips, clip loop/signature/quantization/groove state, audio clip gain/pitch/warp/marker state, devices, device parameters, complete track, master, and return-bus mixer state with named sends, input/output routing state, monitor mode, Session clip envelopes, extended MIDI note properties, and optional NKS catalog search. Guarded mutations cover those transport, musical-context, cue-point, clip-timing, audio-clip, routing, and monitoring fields alongside track/scene creation, exact session-object renaming, Session clip duplication/deletion and clip-loop duplication, scene duplication, content-aware track/scene deletion, tempo, track/master/return-bus mixing, scene and clip launch, clip stop, device parameters, Session clip envelope steps, per-note MIDI properties, MIDI-note quantize/legato/duplicate transforms, and panic. Every mutation requires an observed state version, defaults to a dry-run plan, and uses a short-lived single-use confirmation token for execution.

`get_automation_capabilities` reports the exact supported surface. Ableton Live 12.4.5 exposes Session clip parameter envelopes and the per-note fields pitch, start, duration, velocity, velocity deviation, release velocity, probability, and mute. Its public API does not expose Arrangement automation envelopes or per-note pitch-bend, pressure, and slide curves; the MCP reports those boundaries instead of simulating unsupported writes.

`list_factory_device_profiles` exposes the versioned producer-oriented knowledge catalog for foundational Live devices: Simpler, Sampler, Drum Rack, Analog, Drift, Operator, Wavetable, EQ Eight, Delay, Echo, Reverb, and Hybrid Reverb. `get_factory_device_context` combines a matched profile with the device's live class identity, structural capabilities, and current parameters grouped by musical role. Parameter IDs and bounds always come from the running Live instance rather than a brittle hard-coded index map.

`get_browser_items` traverses one exact level of Live's factory, plug-in, Pack, Max for Live, project, legacy-library, or user-content hierarchy. `search_browser_items` performs a depth- and result-bounded name search below any exact browser path, including mapped Splice folders under User Folders, and returns paths directly usable by `load_browser_item`. Loading resolves the reviewed root/path again at execution time and loads only a unique loadable item onto the guarded target track. The earlier `get_factory_browser_items` and `load_factory_browser_item` names remain compatible aliases.

Device listings include active/bypassed state. `set_device_active` and `delete_device` require the exact observed device identity, current bridge state version, reviewed dry-run plan, and a single-use confirmation token.

`get_device_hierarchy` traverses nested rack chains and devices and reports only loaded Drum Rack pads, with stable path-based IDs and pad-to-chain references. It is read-only and works recursively for racks inside racks.

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

MCP discovery publishes closed top-level JSON Schemas and operation-specific descriptions for every tool. Ableton mutations advertise `expectedStateVersion`; Komplete UI mutations advertise `expectedSessionVersion`, along with their dry-run and confirmation fields.

`get_history_state` exposes Live's current undo/redo availability. Guarded `undo` and `redo` operations refuse unavailable history actions and advance the bridge state version after execution.

## License

Code and the generic example artwork are distributed under the repository's MIT license. Third-party product names belong to their respective owners. No vendor artwork, logos, presets, or implied endorsements are included.
