# ableton-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![M8ven Score](https://m8ven.ai/badge/mcp/cavi-ai/ableton-mcp)](https://m8ven.ai/mcp/cavi-ai/ableton-mcp)

Local-first Ableton Live control for MCP clients. It has three parts: a Remote Script bridge that runs inside Live, a stdio MCP server, and an `ableton-mcp` CLI. Every change to the Live Set is planned first and runs only with a single-use confirmation.

## Install

Requirements: macOS, Ableton Live 12 (tested with 12.4.6), Node.js 22.13 or newer, and `ffmpeg` for the audio analysis tools.

```bash
git clone https://github.com/cavi-ai/ableton-mcp.git
cd ableton-mcp
npm ci
npm run cli -- install
```

In Live's preferences, select **CaviMcpBridge** as a Control Surface. Then check the connection:

```bash
npm run cli -- doctor --json
```

## Quickstart

Register the stdio server with your MCP client, using the absolute path of your checkout:

```json
{
  "mcpServers": {
    "ableton": {
      "command": "node",
      "args": ["/path/to/ableton-mcp/apps/ableton-mcp/src/cli.mjs", "serve"]
    }
  }
}
```

Or call tools from the shell:

```bash
npm run cli -- status --json
npm run cli -- call list_devices --args '{"trackId":"track-0"}' --json
```

Find workflow guidance before choosing individual tools:

```bash
npm run cli -- call get_producer_workflow --args '{"query":"silent part","limit":3}' --json
```

Search returns keyword candidates with their required arguments. Retrieve a chosen reference by its exact `workflow` name and named string `arguments`. Searching and reading guidance do not execute Live operations.

To try client wiring without Live, run `ABLETON_MCP_FIXTURE=1 npm start`.

For a smaller initial tool catalog, set `ABLETON_MCP_TOOL_PROFILE=core` in the MCP server's environment. It advertises 63 common tools instead of the full catalog. Use the default `all` profile when an agent needs the complete MIDI, audio, rack, or snapshot toolset; restart the server after changing profiles. The CLI's direct `call` command remains independent of the discovery profile.

## What it does

For separate creative and functional model contexts, configure optional [production specialists](docs/ableton-mcp/source/pages/guides/production-specialists.md). `ABLETON_MCP_TOOL_PROFILE=producer` exposes twelve tools, with detailed context and durable session history stored in private artifacts. Each role can use an installed Ollama model or a configured ACP agent; Live changes retain their existing confirmation guards.

- **Reads**: transport, tempo, key and scale, quantization, grooves, cue points, tracks, scenes, clips, notes, clip envelopes, devices and parameters, mixer and routing, rack hierarchies, and the Live browser.
- **Guarded mutations**: track, scene and clip lifecycle, device loading and parameters, MIDI note editing, mixing and routing, undo and redo, and panic.
- **Music helpers**: scale-aware chords, basslines, melodies, voicings, arpeggios, strums, drum patterns, humanization and velocity curves.
- **Audio analysis**: loudness, true peak, spectrum, pitch, transients and tuning of local audio files.
- **Optional NKS preset catalog**: search, tags and favorites for presets discovered from your plug-in libraries.

It publishes 328 tools, 9 concrete resources, 13 resource templates and 89 prompt templates. When Live's Remote Script API doesn't expose something, such as Arrangement automation, the tool reports that boundary and fails closed.

## Documentation

- [Remove a Return effect](docs/ableton-mcp/source/pages/guides/return-removal.md)

- [Overview](docs/ableton-mcp/source/pages/introduction/overview.md), [Installation](docs/ableton-mcp/source/pages/introduction/installation.md), [Quickstart](docs/ableton-mcp/source/pages/introduction/quickstart.md)
- [Develop a Session scene](docs/ableton-mcp/source/pages/guides/session-scene-development.md)
- [Remove a Session scene](docs/ableton-mcp/source/pages/guides/session-scene-removal.md)
- [Remove a track or Group](docs/ableton-mcp/source/pages/guides/track-removal.md)
- [Guarded mutations](docs/ableton-mcp/source/pages/guides/guarded-mutations.md) and [MIDI clip variations](docs/ableton-mcp/source/pages/guides/midi-clip-variations.md)
- [Repeat a phrase or play it once](docs/ableton-mcp/source/pages/guides/clip-phrase-loop.md)
- [Cancel agent work](docs/ableton-mcp/source/pages/guides/request-cancellation.md)
- [Resume work after an interruption](docs/ableton-mcp/source/pages/guides/resume-session-work.md)
- [Crop a MIDI phrase](docs/ableton-mcp/source/pages/guides/midi-crop.md)
- [Define MIDI phrase bounds](docs/ableton-mcp/source/pages/guides/midi-clip-markers.md)
- [Create a playable musical sketch](docs/ableton-mcp/source/pages/guides/musical-sketch.md)
- [Reverse a MIDI phrase](docs/ableton-mcp/source/pages/guides/midi-retrograde.md)
- [Organize names and colors](docs/ableton-mcp/source/pages/guides/session-organization.md)
- [Understand a Set and explore instruments](docs/ableton-mcp/source/pages/guides/session-orientation.md)
- [Understand how MIDI parts relate](docs/ableton-mcp/source/pages/guides/musical-parts.md)
- [Keep a Looper performance](docs/ableton-mcp/source/pages/guides/looper-performance.md)
- [Capture and inspect Live audio](docs/ableton-mcp/source/pages/guides/live-audio-capture.md)
- [Navigate to an Arrangement locator](docs/ableton-mcp/source/pages/guides/arrangement-navigation.md)
- [Audition an Arrangement passage](docs/ableton-mcp/source/pages/guides/arrangement-audition.md)
- [Compare instruments while keeping the original](docs/ableton-mcp/source/pages/guides/instrument-comparison.md)
- [Refine an instrument sound](docs/ableton-mcp/source/pages/guides/instrument-refinement.md)
- [Print a part to audio](docs/ableton-mcp/source/pages/guides/track-bounce.md)
- [Freeze and unfreeze track processing](docs/ableton-mcp/source/pages/guides/track-freeze.md)
- [Shape Session clip automation](docs/ableton-mcp/source/pages/guides/clip-automation.md)
- [Arrange Session ideas into sections](docs/ableton-mcp/source/pages/guides/session-arrangement.md)
- [Preset catalog](docs/ableton-mcp/source/pages/guides/preset-catalog.md) and [NKS artwork](docs/ableton-mcp/source/pages/guides/artwork.md)
- [Create a native track Group](docs/ableton-mcp/source/pages/guides/track-grouping.md) and [ungroup tracks](docs/ableton-mcp/source/pages/guides/track-ungrouping.md)
- [Export a native MIDI clip](docs/ableton-mcp/source/pages/guides/midi-export.md)
- [Shared instrument buses](docs/ableton-mcp/source/pages/guides/shared-instrument-buses.md) and [Native saving and recall](docs/ableton-mcp/source/pages/guides/native-saving-and-recall.md)
- [Collect Project samples for handoff](docs/ableton-mcp/source/pages/guides/project-handoff.md)
- [Keep a device sound as a native preset](docs/ableton-mcp/source/pages/guides/native-device-presets.md)
- [CLI](docs/ableton-mcp/source/pages/reference/cli.md), [Configuration](docs/ableton-mcp/source/pages/reference/configuration.md), [Tools](docs/ableton-mcp/source/pages/reference/tools.md)
- [Troubleshooting](docs/ableton-mcp/source/pages/guides/troubleshooting.md)

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ABLETON_MCP_BRIDGE_SOCKET` | `/tmp/cavi-ableton-mcp.sock` | Bridge socket. Read by both the bridge inside Live and the server. |
| `ABLETON_MCP_CATALOG_PATH` | unset | NKS catalog database for preset search. |
| `ABLETON_MCP_BROWSER_METADATA_PATH` | `~/.cavi/ableton-mcp/browser-metadata.sqlite` | Tags and favorites for Live browser items. |
| `ABLETON_MCP_SPLICE_ROOTS` | Existing macOS `~/Splice/Sounds` and `~/Library/Splice/Plug-in/samples` directories; otherwise `[]` | Override with a JSON array of absolute local Splice folders. Set `[]` to disable discovery. Local cache files are not proof of a download license; cloud search and sync are not supported. |
| `ABLETON_MCP_CONFIRMATION_DIR` | `~/.cavi/ableton-mcp/confirmations` | Confirmation tokens for CLI `call`. |
| `ABLETON_MCP_SNAPSHOT_DIR` | `~/.cavi/ableton-mcp/snapshots` | Saved track, device-chain, group-system, and MIDI-feel snapshots in separate subdirectories. |
| `ABLETON_MCP_FIXTURE` | unset | `1` makes `npm start` serve fixture data without Live. |
| `ABLETON_MCP_TOOL_PROFILE` | `all` | `core` advertises 63 common tools to reduce MCP discovery context; `all` advertises every tool. |

## Security

The bridge listens on a Unix domain socket and opens no TCP port. Live Set mutations require an observed state version, return a dry-run plan by default, and execute only with a 60-second, single-use token bound to the plan's hash. See the [security model](docs/ableton-mcp/source/pages/security/model.md) and [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
npm run eval:core
npm run verify:package
```

`npm test` runs the pipeline and server suites, the bridge's Python tests, and the docs tests. `eval:core` checks the compact MCP catalog and read-only tool behavior with MCP Eval. ImageMagick 7 (`magick`) and `ffmpeg` must be installed. `verify:package` packs the npm tarball, installs it into a temporary project, and drives the installed CLI and server.

## Project status

See [GitHub Releases](https://github.com/cavi-ai/ableton-mcp/releases) and the [changelog](CHANGELOG.md) for released versions and changes. The tool surface can still change before 1.0.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The code and the generic example artwork are MIT licensed. Third-party product names belong to their owners. No vendor artwork, logos or presets are included, and no endorsement is implied.
