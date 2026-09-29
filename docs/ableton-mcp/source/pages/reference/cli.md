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

## Live Set files on macOS

`open_live_set` opens an existing absolute `.als` path in the Live app that hosts the bridge. `save_live_set` sends Save to the currently named Set. Both require `expectedStateVersion` and `expectedSetFingerprint` from a fresh `get_live_state` call, and default to a dry-run plan; apply that plan with its single-use `confirmationToken`, `planHash`, and `dryRun:false`. A changed Set or source file invalidates the plan.

These host-side operations may need macOS Automation and Accessibility access for the terminal or MCP host. Live may display a Save As, missing-media, version, or overwrite dialog; the tools do not dismiss dialogs. `open_live_set` reports `opened:true` only after bridge readback identifies the requested path. `save_live_set` reports `saved:true` only after an on-disk change or a clean-state readback. If Live opens a dialog instead, `saved:false` means the save is not verified. Saving an untitled Set requires a manual Save As; this tool does not choose a destination.

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Runs the MCP server. With `ABLETON_MCP_FIXTURE=1` it serves fixture data without Live. |
| `npm test` | Runs the pipeline and server suites, the bridge's Python tests, and the docs tests. |
| `npm run catalog:inventory` | Builds the NKS manifest and catalog from `config/plugins`. |
| `npm run catalog:reconcile-serum-saved -- --manifest <absolute-path> --catalog <absolute-path> --run-log <absolute-path> --browser-db <absolute-path> --user-content-root <absolute-path> [--apply]` | Checks reported Serum pilot saves against current source checksums, Komplete's exact browser index, and readable NKS file bytes. Defaults to dry-run; `--apply` advances only verified records to `nks_saved`. Does not validate recall, mappings, or previews. |
| `npm run catalog:reconcile-preview -- --manifest <absolute-path> --catalog <absolute-path> --preset-id <id> --preview <absolute-path> --sha256 <digest> --capture-report <absolute-path> [--apply]` | Re-measures an already processed 12-second WAV, verifies its checksum and reproducible raw-audio lineage, and checks a preset-bound capture report against the source and saved-NKS evidence; `--apply` advances matching records to `previewed`. Defaults to dry-run. The capture report is operator evidence, not independent proof of Live playback, recall, or mappings. |
| `npm run catalog:reconcile-serum-validation -- --manifest <absolute-path> --catalog <absolute-path> --preset-id <id> --report <absolute-path> [--apply]` | Checks current source, NKS, and preview bytes plus a preset-bound operator report of Komplete recall and at least eight named S88 MK3 controls with hashed observation files. Defaults to dry-run; `--apply` records `validated`. Reported observations are not machine-readable proof of the UI or hardware state. |
| `npm run catalog:omnisphere-pilot -- --manifest <absolute-path> --out <absolute-path> [--apply]` | Plans a deterministic, source-derived Omnisphere pilot across observed banks and top-level categories. Defaults to dry-run; `--apply` writes a new, non-overwriting job packet. Browser navigation, Save As, recall, and hardware mappings remain unverified. |
| `npm run docs:build`, `docs:verify` | Builds and verifies the versioned documentation tree. |
