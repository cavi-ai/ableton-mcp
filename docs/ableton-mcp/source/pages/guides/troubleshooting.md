# Troubleshooting

Start with:

```bash
npm run cli -- doctor --json
```

`bridge.reason` names the failure.

## `connect ENOENT /tmp/cavi-ableton-mcp.sock`

Nothing is listening on the socket. Check that:

- Live is running.
- **CaviMcpBridge** is selected as a Control Surface in Live's preferences.
- The server and Live agree on `ABLETON_MCP_BRIDGE_SOCKET`. Live reads it from its own launch environment, not your shell's.

Selecting the Control Surface again restarts the bridge and recreates the socket.

## `connect ECONNREFUSED`

The socket file exists, but no bridge owns it. This usually follows a Live crash. Select the Control Surface again, or restart Live.

## `outdated bridge: expected 0.1.0` or missing capabilities

Live loaded an older copy of the script. On macOS, a copy inside the application bundle takes precedence over the User Library copy. See [Installation](../introduction/installation.md#an-older-copy-inside-the-application-bundle).

## `bridge request timed out`

The bridge answers from Live's main thread. A modal dialog, or Live being busy loading, delays the answer. Close the dialog and retry.

## `state version mismatch`

The Set changed between the plan and the execution. Read the state again, plan again, and execute the new plan.

## `confirmation token expired` or `unknown confirmation token`

Tokens last 60 seconds and work only once. Plan again. From the CLI, tokens persist between invocations in `ABLETON_MCP_CONFIRMATION_DIR`, so plan and execute with the same user.

## `spawn ffprobe ENOENT` or `spawn ffmpeg ENOENT`

The audio analysis tools need `ffmpeg` and `ffprobe` on `PATH`. MCP clients often launch servers with a minimal `PATH`. If yours does, set `PATH` in the server entry.

## Preset search returns nothing

`ABLETON_MCP_CATALOG_PATH` is unset, or the catalog is empty. `doctor` reports `catalog.configured`. Build the catalog with `npm run catalog:inventory`; see [Preset catalog](preset-catalog.md).

## `ExperimentalWarning: SQLite is an experimental feature`

Node.js 22 prints this on stderr when the SQLite module loads. It doesn't affect the MCP protocol, which uses stdout. Node.js 24 doesn't print it.
