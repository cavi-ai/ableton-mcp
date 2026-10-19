# Installation

## Requirements

- macOS. The bridge transport is a Unix domain socket, so Windows is not supported.
- Ableton Live 12. Tested with 12.4.6.
- Node.js 22.13 or newer.
- `ffmpeg` and `ffprobe`, for the audio analysis tools.
- ImageMagick 7 (`magick`), only for the NKS artwork pipeline.
- Python 3, only for running the bridge's unit tests. Live runs the bridge with its own Python.

## Install the server

```bash
git clone https://github.com/cavi-ai/ableton-mcp.git
cd ableton-mcp
npm ci
```

## Install the bridge

```bash
npm run cli -- install
```

This copies `CaviMcpBridge` into `~/Music/Ableton/User Library/Remote Scripts`. It copies nothing else. Then open Live's preferences, go to **Link, Tempo & MIDI**, and select **CaviMcpBridge** as a Control Surface.

Pass `--destination <Remote Scripts path>` if your User Library is somewhere else. `npm run cli -- uninstall` removes only the installed `CaviMcpBridge` directory.

### An older copy inside the application bundle

An older copy of the script inside the application bundle can take precedence over the User Library copy. If `doctor` reports an outdated bridge after installing, check and update that copy:

```bash
npm run cli -- install --destination "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/MIDI Remote Scripts"
```

Then restart Live. This modifies the application bundle; the default install does not. A Live update can replace the copy, so run `doctor` again after updating Live.

## Check the connection

```bash
npm run cli -- doctor --json
```

`ok: true` means the bridge answered on the socket, reports version {{PRODUCT_VERSION}}, and advertises every capability the server needs. If it doesn't, see [Troubleshooting](../guides/troubleshooting.md).
