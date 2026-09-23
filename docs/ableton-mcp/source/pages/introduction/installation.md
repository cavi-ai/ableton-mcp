# Installation

## Requirements

- macOS. The bridge transport is a Unix domain socket, so Windows is not supported.
- Ableton Live 12. Tested with 12.4.5.
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

On the tested Live 12.4.5 installation, an older copy of the same script inside the application bundle took precedence over both the User Library and the preferences-directory copies. If `doctor` reports an outdated bridge after installing, update that copy:

```bash
npm run cli -- install --destination "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/MIDI Remote Scripts"
```

Then restart Live. This modifies the application bundle; the default install does not. A Live update can replace the copy, so run `doctor` again after updating Live.

## Check the connection

```bash
npm run cli -- doctor --json
```

`ok: true` means the bridge answered on the socket, reports version 0.1.0, and advertises every capability the server needs. If it doesn't, see [Troubleshooting](../guides/troubleshooting.md).
