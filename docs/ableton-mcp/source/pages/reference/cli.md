# CLI

From a checkout, run `npm run cli -- <command>`, or `node apps/ableton-mcp/src/cli.mjs <command>`. The package installs the same entrypoint as `ableton-mcp`. Add `--json` to any command for machine-readable output.

| Command | What it does |
|---|---|
| `help` | Lists the commands. |
| `install [--destination <path>]` | Copies `CaviMcpBridge` into the Remote Scripts folder. The default is `~/Music/Ableton/User Library/Remote Scripts`. Tests and bytecode are skipped. |
| `uninstall [--destination <path>]` | Removes only the installed `CaviMcpBridge` directory. |
| `doctor` | Distinguishes socket/protocol connection from Live-state availability; reports structured failures, observed capabilities, catalog configuration and Remote Scripts copies. |
| `identity` | Prints the packaged runtime fingerprint without connecting to Live. |
| `serve` | Runs a managed MCP server over stdio. |
| `restart [--pid <pid>]` | Replaces one idle managed server worker with this package and verifies its fingerprint while preserving the host connection. Select a PID when multiple servers are running. |
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

Restart refuses active or unsettled requests and never replays operations. Make fresh dry-run plans after restarting; in-memory confirmation tokens are discarded and native handles must be inspected again. Durable production sessions remain in their configured artifact directory and require a fresh `resume` inspection.

Only servers launched by this version's `serve` command support managed restart. Older running servers need a host reconnect once. `ABLETON_MCP_SERVER_DIRECTORY` can override the private registration directory, which defaults to `~/.cavi/ableton-mcp/servers`. Registration files contain local control credentials; keep the directory private.

## Live Set files on macOS

`open_live_set` opens an existing absolute `.als` path in the Live app that hosts the bridge. `save_live_set` sends Save to the currently named Set, or performs Save As when an explicit new `path` is supplied. Default opening and saving require `expectedStateVersion` and `expectedSetFingerprint` from a fresh `get_live_state` call, and default to a dry-run plan; apply that plan with its single-use `confirmationToken`, `planHash`, and `dryRun:false`. A changed Set or source file invalidates the plan.

### Open a Set when Live is closed

Set `ABLETON_MCP_LIVE_APP_PATH` to the installed Live `.app` bundle in the MCP server's environment. Plan `open_live_set` with `mode: "launch"` and an existing absolute `.als` path:

```bash
npm run cli -- call open_live_set --args '{"mode":"launch","path":"/absolute/path/Song.als"}' --json
```

Launch mode uses the configured app identity, Set file version and observed OS process state instead of `expectedStateVersion` and `expectedSetFingerprint`. It refuses any running Live process, including one whose bridge is unavailable. It rechecks app, file and process state before consuming the single-use confirmation. Execute the reviewed plan with the same `mode` and `path`, plus its token/hash and `dryRun:false`. An expired or stale plan requires a fresh observation.

The configured bridge socket is passed to a new app instance through Launch Services. Cold launch does not send the Set to an intervening existing process. If another instance appears concurrently, running-app identity remains unverified; inspect the apps before retrying. The tool waits for bridge readiness for up to 45 seconds, subject to individual request timeouts, and reports `opened:true` only when the requested Set path and configured running app are both observed. `launchRequested:true` alone is not success. A lost launch reply or failed process observation returns `startupStatus: "unverified"` with the launch request retained. Live may still be loading or waiting at a dialog. The tool does not close apps or dismiss dialogs. After successful opening, use `get_session_orientation` to understand the actual Set before editing.

These host-side operations may need macOS Automation and Accessibility access for the terminal or MCP host. Live may display missing-media, version, or overwrite dialogs; these are not accepted automatically. `open_live_set` reports `opened:true` only after bridge readback identifies the requested path. `save_live_set` reports `saved:true` only after an on-disk change or a clean-state readback. If Live opens a dialog instead, `saved:false` means the save is not verified. An untitled Set requires an explicit Save As destination.

When the bridge's dirty state is unavailable, an ordinary save of a named Set can also use Live's English File menu: Save Live Set is disabled while Save Live Set As remains enabled. This requires the sole configured Live process, its foreground main document URL matching the exact file, no modal or sheet, and matching bridge identity before and after observation. An explicit dirty state, missing permissions, unfamiliar menus, a different document or ambiguous UI provide no menu-based clean-state evidence. Normal file-write and bridge-clean verification remain available.

Ordinary-save receipts include `verification.basis`: `file-change`, `bridge-clean`, `native-save-menu`, or `unverified`. A clean Set can return `saved:true` and `pendingUserAction:false` with `fileWriteObserved:false`; that confirms clean state without claiming a new disk write. `fileWriteObserved` reports whether file size or modification time changed. Unknown state stays unverified; an unchanged file alone is not success. Save As retains its separate destination/file requirements below.

### Save a separate working Set

Pass `save_live_set` a new absolute `.als` `path`, plus `expectedStateVersion` and `expectedSetFingerprint` from fresh state. This works for named and untitled Sets. The parent directory must already exist. The dry-run plan shows `destination.requestedPath`, the resulting `destination.path`, and `createsProject`. Inside an existing Live project, the file stays in the chosen directory. Outside a project, Live creates `<Set name> Project/<Set name>.als`. Existing destination files, symlinks and would-be project folders are refused; choose a different name. Filenames must be visible, at most 128 characters, and contain no colons or control characters.

Apply the reviewed plan with the same arguments, its single-use token/hash, and `dryRun:false`. The operation targets the sole running Live app, refuses an existing dialog, and uses the English Live Save Live Set As menu command and native controls. Other Live languages are currently refused. The native window identity and Save As purpose must match from preparation through Save. It rechecks the current Set, source file, destination and project directory before pressing Save. Changed context invalidates the operation. It never accepts Replace or another unexpected dialog.

`saved:true` requires both Live's resulting Set path and a nonempty regular `.als` file at the planned destination. A lost response, unexpected dialog, changed context or missing readback returns an unverified receipt; inspect Live and the destination before retrying. Cancellation may leave the native dialog visible. No partial output is deleted automatically.

Save As switches Live to the new working Set. It preserves the earlier Set file but does not make a self-contained media backup: samples can remain external references. Collect All and Save is a separate native action and is not automated by this operation. Refresh orientation and object identities after saving before making further changes.

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
