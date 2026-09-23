# Configuration

All configuration is environment variables. Each one is optional.

| Variable | Default | Purpose |
|---|---|---|
| `ABLETON_MCP_BRIDGE_SOCKET` | `/tmp/cavi-ableton-mcp.sock` | The bridge's Unix socket. Read by both the bridge inside Live and the server. |
| `ABLETON_MCP_CATALOG_PATH` | unset | The NKS catalog database for preset search. Unset means preset search returns an empty collection. |
| `ABLETON_MCP_BROWSER_METADATA_PATH` | `~/.cavi/ableton-mcp/browser-metadata.sqlite` | Tags and favorites for Live browser items. |
| `ABLETON_MCP_CONFIRMATION_DIR` | `~/.cavi/ableton-mcp/confirmations` | Single-use confirmation tokens for CLI `call`. |
| `ABLETON_MCP_SNAPSHOT_DIR` | `~/.cavi/ableton-mcp/snapshots` | Saved track-state snapshots from `save_track_state_snapshot`. |
| `ABLETON_MCP_FIXTURE` | unset | `1` makes `npm start` serve fixture data without Live. `ableton-mcp serve` ignores it. |

Live reads `ABLETON_MCP_BRIDGE_SOCKET` from its own launch environment. Apps started from the Dock or Finder don't inherit your shell's variables. If you change the socket, start Live's executable from the same shell, for example `"/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live"`.

## Files

| Path | Purpose |
|---|---|
| `config/plugins/*.json` | Per-product preset discovery for the NKS catalog. See [Preset catalog](../guides/preset-catalog.md). |
| `config/artwork/*.json` | Inputs for the NKS artwork pipeline. See [NKS artwork](../guides/artwork.md). |
| `reports/nks/` | Default manifest and catalog output. Ignored by git. |
