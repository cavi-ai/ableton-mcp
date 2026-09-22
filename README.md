# Ableton MCP

Local-first Ableton Live control through an installable Remote Script, MCP server, and command-line interface. NKS catalog integration is optional.

## Quick start

Tested on macOS with Ableton Live 12.4.5.

```bash
git clone https://github.com/cavi-ai/ableton-mcp.git
cd ableton-mcp
npm ci
npm run cli -- install
```

Enable **CaviMcpBridge** as a Control Surface in Live's preferences, then check the connection:

```bash
npm run cli -- doctor --json
```

Register the stdio server with an MCP client, using the absolute path of the checkout:

```json
{
  "mcpServers": {
    "ableton": {
      "command": "node",
      "args": ["/path/to/ableton-mcp/apps/ableton-nks-mcp/src/cli.mjs", "serve"]
    }
  }
}
```

## Repository layout

- `apps/ableton-nks-mcp` — MCP server, CLI, and tests
- `packages/nks-pipeline` — preset inventory, catalog, artwork, preview, and generation helpers
- `ableton/Remote Scripts/CaviMcpBridge` — Ableton Live bridge
- `config` — product and artwork configuration; set each plugin's `factoryRoots` in `config/plugins/*.json` to your local preset library (empty roots discover nothing)
- `examples/artwork` — redistributable generic artwork for exercising the renderer
- `schemas` — manifest schemas

Generated presets, artwork, catalogs, and factory-source files are not part of this repository.

User favorites and normalized tags are stored in dedicated catalog tables rather than altering vendor preset records. `get_preset_metadata` returns the exact metadata revision; guarded `set_preset_metadata` requires that revision plus the standard dry-run confirmation before replacing tags or favorite state. `search_presets` can filter by favorite state and require all supplied tags.

## Control surface

Read operations expose Live status including the set file path, playhead, transport-recording, metronome, and count-in context, song key/scale and timing context, global and recording quantization, groove pool and swing state, Arrangement loop and cue-point state, tracks, scenes with per-scene launch quantization, clips, clip loop/signature/quantization/groove state, audio clip gain/pitch/warp/marker state, devices, device parameters, complete track, master, and return-bus mixer state with named sends, input/output routing state, monitor mode, track MIDI note routing (MIDIMap input/output notes and scale transposition), track freeze state, Session clip envelopes, extended MIDI note properties on Session and Arrangement MIDI clips, and optional NKS catalog search. Guarded mutations cover those transport, musical-context, cue-point, clip-timing, audio-clip, routing, monitoring, and track MIDI note-routing fields alongside track/scene creation, groove-pool creation, per-scene launch-quantization overrides, exact session-object renaming, Session clip duplication/deletion and clip-loop duplication, scene duplication, content-aware track/scene deletion, tempo, track/master/return-bus mixing, scene and clip launch, clip stop, device parameters, Session clip envelope steps, per-note MIDI properties and quantize/legato/duplicate transforms on Session and Arrangement MIDI clips, deterministic MIDI humanization, complete-onset crescendo/decrescendo/fixed/accent velocity curves, guarded track freeze/unfreeze (readable state; on Live 12.4.5 the native property has no setter so the write fails closed), one-step bulk track-mixer changes and native stop-all-clips, and panic. Every mutation requires an observed state version, defaults to a dry-run plan, and uses a short-lived single-use confirmation token for execution.

`get_automation_capabilities` reports the exact supported surface. Ableton Live 12.4.5 exposes Session clip parameter envelopes and the per-note fields pitch, start, duration, velocity, velocity deviation, release velocity, probability, and mute. Its public API does not expose Arrangement automation envelopes or per-note pitch-bend, pressure, and slide curves; the MCP reports those boundaries instead of simulating unsupported writes.

`list_factory_device_profiles` exposes the producer-oriented knowledge catalog for Live instruments, racks, MIDI effects, dynamics, gain/stereo tools, saturation, EQ, delay, reverb, and pitch correction. Query the tool for the current exact catalog. `get_factory_device_context` combines a matched profile with the device's live class identity, structural capabilities, and current parameters grouped by musical role. Parameter IDs and bounds always come from the running Live instance rather than a brittle hard-coded index map.

See [Shared instrument audio buses](docs/shared-instrument-buses.md) for building processed buses with separate instrument children, routing verification, processing order, and explicit group/template limitations.

`create_return_track` appends a guarded shared-effects bus through Live's native API. `create_groove` appends a new groove to the Groove Pool; adjust its base grid and amounts afterward with `set_groove`. Live-verified boundaries: Live 12.4.5 does not expose Group Track creation or ungrouping to Remote Scripts, its public Groove Pool API has no creation or deletion method, per-scene launch quantization, per-track MIDIMap note routing, or a writable `Track.is_frozen` (freeze stays UI-only), so `get_live_state.nativeApiSupport` and fail-closed reads report those boundaries instead of advertising nonfunctional controls.

See [Native saving and recall](docs/native-saving-and-recall.md) for Live Set and device-preset UI workflows, recall checks, and the current MCP/CLI boundaries.

`get_browser_items` traverses one exact level of Live's factory, plug-in, Pack, Max for Live, project, legacy-library, or user-content hierarchy. `search_browser_items` performs a depth- and result-bounded name search below any exact browser path, including mapped Splice folders under User Folders, and returns paths directly usable by `load_browser_item`. Loading resolves the reviewed root/path again at execution time and loads only a unique loadable item onto the guarded target track. The earlier `get_factory_browser_items` and `load_factory_browser_item` names remain compatible aliases.

`search_local_splice_samples` searches audio filenames under an explicit local Splice asset directory, returning canonical source paths for `analyze_audio_file`. It skips symlinks and non-audio files. This is local-file discovery, not Splice cloud catalog search, download, or sync; Live browser loading still requires the directory to be mapped into Live's User Folders.

Device listings include active/bypassed state. `set_device_active` and `delete_device` require the exact observed device identity, current bridge state version, reviewed dry-run plan, and a single-use confirmation token.

`get_device_hierarchy` traverses nested rack chains and devices and reports only loaded Drum Rack pads, with stable path-based IDs and pad-to-chain references. It is read-only and works recursively for racks inside racks.

## Artwork model

The repository does not scrape or auto-populate vendor artwork. Operators provide an authoritative master image and metadata; the pipeline deterministically renders Native Instruments product, bank, category, and size variants. Generated derivatives and installation staging remain build outputs rather than source-controlled assets.

`examples/artwork/generic-synth-master.png` is an original, vendor-neutral fixture for documentation and renderer tests. Its provenance is recorded beside it. Product-specific masters are not part of this repository.

## Requirements

- Node.js 22 or newer
- Python 3 for bridge tests
- Ableton Live for live integration
- ImageMagick 7 (`magick`) for artwork rendering and tests
- ffmpeg for audio analysis and tests

## Development

```bash
npm ci
npm test
```

`npm test` runs the pipeline and MCP Node suites, then the bridge's Python unit tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

## CLI

```bash
npm run cli -- help
npm run cli -- install
npm run cli -- doctor --json
npm run cli -- serve
npm run cli -- status --json
npm run cli -- resource ableton://set/tracks --json
npm run cli -- prompts --json
npm run cli -- prompt harmonize-clip --args '{"trackId":"track-0","clipId":"track-0:clip-0"}' --json
npm run cli -- call list_devices --args '{"trackId":"track-0"}' --json
```

`install` copies only `CaviMcpBridge` into the user-level Ableton Remote Scripts directory by default. Enable **CaviMcpBridge** as a Control Surface in Ableton Live preferences after installation. On the tested Live 12.4.5 installation, an older copy of the same script inside the application bundle shadowed both the User Library and profile-directory copies. In that case, update only the existing custom script using `ableton-mcp install --destination "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/MIDI Remote Scripts"`, then restart Live. Application updates may replace this copy, so re-check the installed script after updating Live. This explicitly targeted install modifies the application bundle; the default install does not.

Use `ableton-mcp uninstall` to remove only that installed script directory. Pass `--destination <Remote Scripts path>` when the Ableton User Library is in a non-default location.

Run the MCP server in fixture mode:

```bash
ABLETON_NKS_MCP_FIXTURE=1 npm start
```

Set `ABLETON_NKS_CATALOG_PATH` only when local preset search is wanted. Without it, preset search returns an empty collection.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CAVI_MCP_BRIDGE_SOCKET` | `/tmp/cavi-ableton-mcp.sock` | Remote Script bridge socket; read by both the bridge inside Live and the server |
| `ABLETON_NKS_CATALOG_PATH` | unset | NKS catalog database for preset search |
| `CAVI_MCP_BROWSER_METADATA_PATH` | `~/.cavi/ableton-mcp/browser-metadata.sqlite` | Metadata for Live browser items |
| `CAVI_MCP_CONFIRMATION_DIR` | `~/.cavi/ableton-mcp/confirmations` | Single-use confirmation tokens |
| `CAVI_MCP_SNAPSHOT_DIR` | `~/.cavi/ableton-mcp/snapshots` | Track and device-chain snapshots |
| `KOMPLETE_AUTOMATION_SOCKET` | `/tmp/cavi-komplete-automation.sock` | Socket for the Komplete automation tools; the service listening on it is not part of this repository |
| `ABLETON_NKS_MCP_FIXTURE` | unset | `1` makes `npm start` serve fixture data without Live |

## Safety

Mutating Ableton operations use plan hashes and short-lived, single-use confirmation tokens. Keep generated commercial preset content out of this repository.

MCP discovery publishes closed top-level JSON Schemas and operation-specific descriptions for every tool, plus a `prompts` capability with producer workflow templates (`session-overview`, `produce-drum-pattern`, `harmonize-clip`, `build-producer-chain`, `arrangement-rework`). Every tool advertises MCP annotations (`readOnlyHint`/`destructiveHint`). Ableton mutations advertise `expectedStateVersion`; Komplete UI mutations advertise `expectedSessionVersion`, along with their dry-run and confirmation fields.

`get_history_state` exposes Live's current undo/redo availability. Guarded `undo` and `redo` operations refuse unavailable history actions and advance the bridge state version after execution.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

Code and the generic example artwork are distributed under the repository's MIT license. Third-party product names belong to their respective owners. No vendor artwork, logos, presets, or implied endorsements are included.
