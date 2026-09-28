# Configuration

All configuration is environment variables. Each one is optional.

| Variable | Default | Purpose |
|---|---|---|
| `ABLETON_MCP_BRIDGE_SOCKET` | `/tmp/cavi-ableton-mcp.sock` | The bridge's Unix socket. Read by both the bridge inside Live and the server. |
| `ABLETON_MCP_CATALOG_PATH` | unset | The NKS catalog database for preset search. Unset means preset search returns an empty collection. |
| `ABLETON_MCP_BROWSER_METADATA_PATH` | `~/.cavi/ableton-mcp/browser-metadata.sqlite` | Tags and favorites for Live browser items. |
| `ABLETON_MCP_SPLICE_ROOTS` | Existing macOS `~/Splice/Sounds` and `~/Library/Splice/Plug-in/samples` directories; otherwise `[]` | Override with a JSON array of absolute local folders, or set `[]` to disable detection. `list_local_splice_roots` reports availability. Cache files do not establish license rights; cloud search and sync are not supported. |

| `ABLETON_MCP_CONFIRMATION_DIR` | `~/.cavi/ableton-mcp/confirmations` | Single-use confirmation tokens for CLI `call`. |
| `ABLETON_MCP_SNAPSHOT_DIR` | `~/.cavi/ableton-mcp/snapshots` | Private named track-state snapshots; device-chain and MIDI-feel templates use separate subdirectories. |
| `ABLETON_MCP_FIXTURE` | unset | `1` makes `npm start` serve fixture data without Live. `ableton-mcp serve` ignores it. |
| `ABLETON_MCP_TOOL_PROFILE` | `all` | `core` advertises 60 common MCP tools; `all` advertises the full catalog. Changing this requires a server restart. CLI `call` is unaffected. |

Local Splice search is separate from Live's browser. To load a local cache file through Live, add its containing folder to Live's **Places → Add Folder**, then search that exact `user_folders` subtree with `search_browser_items` and pass the returned path to `load_browser_item`. A WAV loaded onto an audio track can create a Session clip without adding a device; inspect `clipEffect` and the clip state, not only `deviceChainEffect`. Live's built-in Splice browser root may still be unavailable when its account integration is not active.

Live reads `ABLETON_MCP_BRIDGE_SOCKET` from its own launch environment. Apps started from the Dock or Finder don't inherit your shell's variables. If you change the socket, start Live's executable from the same shell, for example `"/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live"`.

## Files

| Path | Purpose |
|---|---|
| `config/plugins/*.json` | Per-product preset discovery for the NKS catalog. See [Preset catalog](../guides/preset-catalog.md). |
| `config/artwork/*.json` | Inputs for the NKS artwork pipeline. See [NKS artwork](../guides/artwork.md). |
| `reports/nks/` | Default manifest and catalog output. Ignored by git. |
