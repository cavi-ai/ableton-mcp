# ableton-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![M8ven Score](https://m8ven.ai/badge/mcp/cavi-ai/ableton-mcp)](https://m8ven.ai/mcp/cavi-ai/ableton-mcp)

Local-first Ableton Live control for MCP clients. It has three parts: a Remote Script bridge that runs inside Live, a stdio MCP server, and an `ableton-mcp` CLI. Every change to the Live Set is planned first and runs only with a single-use confirmation.

## Install

Requirements: macOS, Ableton Live 12 (tested with 12.4.5), Node.js 22.13 or newer, and `ffmpeg` for the audio analysis tools.

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

To try client wiring without Live, run `ABLETON_MCP_FIXTURE=1 npm start`.

For a smaller initial tool catalog, set `ABLETON_MCP_TOOL_PROFILE=core` in the MCP server's environment. It advertises 55 common tools instead of all 183. Use the default `all` profile when an agent needs the complete MIDI, audio, rack, or snapshot toolset; restart the server after changing profiles. The CLI's direct `call` command remains independent of the discovery profile.

## What it does

- **Reads**: transport, tempo, key and scale, quantization, grooves, cue points, tracks, scenes, clips, notes, clip envelopes, devices and parameters, mixer and routing, rack hierarchies, and the Live browser.
- **Guarded mutations**: track, scene and clip lifecycle, device loading and parameters, MIDI note editing, mixing and routing, undo and redo, and panic.
- **Music helpers**: scale-aware chords, basslines, melodies, voicings, arpeggios, strums, drum patterns, humanization and velocity curves.
- **Audio analysis**: loudness, true peak, spectrum, pitch, transients and tuning of local audio files.
- **Optional NKS preset catalog**: search, tags and favorites for presets discovered from your plug-in libraries.

It publishes 183 tools, 22 resources and 5 prompt templates. When Live's Remote Script API doesn't expose something, such as Arrangement automation, Group Track creation, or freezing, the tool reports that boundary and fails closed.

## Documentation

- [Overview](docs/ableton-mcp/source/pages/introduction/overview.md), [Installation](docs/ableton-mcp/source/pages/introduction/installation.md), [Quickstart](docs/ableton-mcp/source/pages/introduction/quickstart.md)
- [Guarded mutations](docs/ableton-mcp/source/pages/guides/guarded-mutations.md)
- [Preset catalog](docs/ableton-mcp/source/pages/guides/preset-catalog.md) and [NKS artwork](docs/ableton-mcp/source/pages/guides/artwork.md)
- [Shared instrument buses](docs/ableton-mcp/source/pages/guides/shared-instrument-buses.md) and [Native saving and recall](docs/ableton-mcp/source/pages/guides/native-saving-and-recall.md)
- [CLI](docs/ableton-mcp/source/pages/reference/cli.md), [Configuration](docs/ableton-mcp/source/pages/reference/configuration.md), [Tools](docs/ableton-mcp/source/pages/reference/tools.md)
- [Troubleshooting](docs/ableton-mcp/source/pages/guides/troubleshooting.md)

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ABLETON_MCP_BRIDGE_SOCKET` | `/tmp/cavi-ableton-mcp.sock` | Bridge socket. Read by both the bridge inside Live and the server. |
| `ABLETON_MCP_CATALOG_PATH` | unset | NKS catalog database for preset search. |
| `ABLETON_MCP_BROWSER_METADATA_PATH` | `~/.cavi/ableton-mcp/browser-metadata.sqlite` | Tags and favorites for Live browser items. |
| `ABLETON_MCP_CONFIRMATION_DIR` | `~/.cavi/ableton-mcp/confirmations` | Confirmation tokens for CLI `call`. |
| `ABLETON_MCP_SNAPSHOT_DIR` | `~/.cavi/ableton-mcp/snapshots` | Saved track-state snapshots. |
| `ABLETON_MCP_FIXTURE` | unset | `1` makes `npm start` serve fixture data without Live. |
| `ABLETON_MCP_TOOL_PROFILE` | `all` | `core` advertises 55 common tools to reduce MCP discovery context; `all` advertises every tool. |

## Security

The bridge listens on a Unix domain socket and opens no TCP port. Mutations require an observed state version, return a dry-run plan by default, and execute only with a 60-second, single-use token bound to the plan's hash. See the [security model](docs/ableton-mcp/source/pages/security/model.md) and [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
npm run verify:package
```

`npm test` runs the pipeline and server suites, the bridge's Python tests, and the docs tests. ImageMagick 7 (`magick`) and `ffmpeg` must be installed. `verify:package` packs the npm tarball, installs it into a temporary project, and drives the installed CLI and server.

## Project status

Version 0.1.0 is unreleased. The tool surface can still change before 1.0.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The code and the generic example artwork are MIT licensed. Third-party product names belong to their owners. No vendor artwork, logos or presets are included, and no endorsement is implied.
