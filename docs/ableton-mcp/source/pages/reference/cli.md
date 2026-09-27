# CLI

From a checkout, run `npm run cli -- <command>`, or `node apps/ableton-mcp/src/cli.mjs <command>`. The package installs the same entrypoint as `ableton-mcp`. Add `--json` to any command for machine-readable output.

| Command | What it does |
|---|---|
| `help` | Lists the commands. |
| `install [--destination <path>]` | Copies `CaviMcpBridge` into the Remote Scripts folder. The default is `~/Music/Ableton/User Library/Remote Scripts`. Tests and bytecode are skipped. |
| `uninstall [--destination <path>]` | Removes only the installed `CaviMcpBridge` directory. |
| `doctor` | Probes the bridge socket and reports the bridge version, missing capabilities, catalog configuration and Remote Scripts folders. |
| `serve` | Runs the MCP server over stdio. |
| `status` | Calls `get_live_state`. |
| `call <tool> [--args '<json>']` | Validates the arguments against the tool's schema, then calls it. Confirmation tokens persist between calls in `ABLETON_MCP_CONFIRMATION_DIR`. |
| `resource <uri>` | Reads one MCP resource, for example `ableton://set/tracks`. |
| `prompts` | Lists the prompt templates. |
| `prompt <name> [--args '<json>']` | Renders one prompt template. |

## Examples

```bash
npm run cli -- doctor --json
npm run cli -- resource ableton://track/track-0/devices --json
npm run cli -- prompt harmonize-clip --args '{"trackId":"track-0","clipId":"track-0:clip-0"}' --json
npm run cli -- call list_devices --args '{"trackId":"track-0"}' --json
```

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Runs the MCP server. With `ABLETON_MCP_FIXTURE=1` it serves fixture data without Live. |
| `npm test` | Runs the pipeline and server suites, the bridge's Python tests, and the docs tests. |
| `npm run catalog:inventory` | Builds the NKS manifest and catalog from `config/plugins`. |
| `npm run catalog:reconcile-serum-saved -- --manifest <absolute-path> --catalog <absolute-path> --run-log <absolute-path> --browser-db <absolute-path> --user-content-root <absolute-path> [--apply]` | Checks reported Serum pilot saves against current source checksums, Komplete's exact browser index, and readable NKS file bytes. Defaults to dry-run; `--apply` advances only verified records to `nks_saved`. Does not validate recall, mappings, or previews. |
| `npm run catalog:reconcile-preview -- --manifest <absolute-path> --catalog <absolute-path> --preset-id <id> --preview <absolute-path> --sha256 <digest> [--apply]` | Re-measures an already processed 12-second WAV, checks its exact checksum, source fingerprint, and saved-NKS evidence; `--apply` advances matching manifest and catalog records to `previewed`. Defaults to dry-run. Does not capture Live audio or prove recall and mappings. |
| `npm run docs:build`, `docs:verify` | Builds and verifies the versioned documentation tree. |
