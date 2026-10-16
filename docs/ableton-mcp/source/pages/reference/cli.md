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

`open_live_set` opens an existing absolute `.als` path in the Live app that hosts the bridge. `save_live_set` sends Save to the currently named Set. Default opening and saving require `expectedStateVersion` and `expectedSetFingerprint` from a fresh `get_live_state` call, and default to a dry-run plan; apply that plan with its single-use `confirmationToken`, `planHash`, and `dryRun:false`. A changed Set or source file invalidates the plan.

### Open a Set when Live is closed

Set `ABLETON_MCP_LIVE_APP_PATH` to the installed Live `.app` bundle in the MCP server's environment. Plan `open_live_set` with `mode: "launch"` and an existing absolute `.als` path:

```bash
npm run cli -- call open_live_set --args '{"mode":"launch","path":"/absolute/path/Song.als"}' --json
```

Launch mode uses the configured app identity, Set file version and observed OS process state instead of `expectedStateVersion` and `expectedSetFingerprint`. It refuses any running Live process, including one whose bridge is unavailable. It rechecks app, file and process state before consuming the single-use confirmation. Execute the reviewed plan with the same `mode` and `path`, plus its token/hash and `dryRun:false`. An expired or stale plan requires a fresh observation.

The configured bridge socket is passed to a new app instance through Launch Services. Cold launch does not send the Set to an intervening existing process. If another instance appears concurrently, running-app identity remains unverified; inspect the apps before retrying. The tool waits for bridge readiness for up to 45 seconds, subject to individual request timeouts, and reports `opened:true` only when the requested Set path and configured running app are both observed. `launchRequested:true` alone is not success. A lost launch reply or failed process observation returns `startupStatus: "unverified"` with the launch request retained. Live may still be loading or waiting at a dialog. The tool does not close apps or dismiss dialogs. After successful opening, use `get_session_orientation` to understand the actual Set before editing.

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
