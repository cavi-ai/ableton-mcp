# Changelog

## Unreleased

## 0.4.0

- Preserve per-operation production attempts and receipts across interruptions, add explicit recovery proposals, and expose runtime fingerprints with guarded CLI server restart.
- Add opt-in Claude, Codex, OpenClaw, Hermes, OpenCode and AGY production specialists through `@cavi-ai/api-client`, with environment-based credentials, bounded output and existing proposal and confirmation guards.
- Distinguish read-only inspections, executable change proposals, incomplete tasks and freshly verified no-change outcomes. Empty functional responses no longer advance change tasks to acceptance.
- Validate guarded plans, execution receipts, producer results and important Live reads through MCP and CLI, preserving unknown outcomes for malformed write receipts.
- Retrieve bounded specialist schemas from task metadata while retaining exact-name discovery, role restrictions and the full tool catalog.
- Expose production boundaries and handoffs for unsupported automation, envelope recovery, hidden plug-in state, partial tasks and listening acceptance.
- Add opt-in live workflow acceptance for mixer, MIDI, device and durable reconnect/resume tasks against an explicit scratch Set.

## 0.3.1

- Added a shared execution-outcome contract for guarded Live mutations and production sessions, preserving native receipts and keeping partial, failed or pending work out of applied status.
- Require verified Session overdub scope and recording-switch receipts, and preserve successful meter edits when an optional loop object is empty.
- Reject malformed and conflicting producer scopes before Live observation or specialist calls, including saved tasks.
- Corrected tool effect annotations and added a directory profile exposing individual native tools without producer coordinators.

## 0.3.0

- Added production workflow discovery, bounded creative and functional specialists, and durable sessions with caller-defined completion checks.
- Expanded Session and Arrangement composition, MIDI editing, clip comparison, recording, capture, and audio export workflows.
- Added native instrument comparisons, browser previews, rack performance controls, and audio capture and analysis.
- Strengthened native identity, recording, automation, routing, and readback checks for track, Group, Return, and Main operations.
- Added Group and solo signal context, shared-bus production sessions, and detection of musical-context changes before continuing saved proposals.
- Preserved completed production evidence across playback-only version changes while requiring fresh outcome checks before acceptance.

Upgrade the server and CaviMcpBridge together, reinstall the Remote Script, restart Live, and run `ableton-mcp doctor` to confirm matching versions.

## 0.2.1

- Corrected MCP ping handling and read-only output schemas and validation.
- Improved discovery of valid scale, browser, device, populated clip, and local audio-source targets without creating session content.
- Reduced core catalog context overhead and tightened the MCP Eval discovery and token budgets.
- Batched coherent song-grid reads and independent plug-in parameter and browser reads while retaining state-version and identity checks.
- Removed the recurring bridge scheduling delay by draining on each main-thread display callback inside Live's component guard.
- Updated MCP Eval to 0.4.0.

## 0.2.0

- Expanded producer workflows, including guarded group-system snapshot recall.
- Added bridge script origin to Live state and CLI diagnostics to identify the loaded Remote Script copy.
- Kept Live Set mutations behind state-version and confirmation-token guards.

## 0.1.0 — 2026-09-23

- MCP server, CLI, and Ableton Live Remote Script bridge
- Guarded mutations: dry-run plans, state versions, single-use confirmation tokens
- Read-only MCP resources and producer workflow prompts
- Optional NKS preset catalog: `npm run catalog:inventory` builds it from `config/plugins`; `search_presets` searches every product unless `productSlug` is given
- Presets no longer found on disk are flagged `missing` and hidden from search; tags and favorites are kept
- Optional NKS artwork pipeline
- Environment variables use the `ABLETON_MCP_` prefix
- Versioned documentation under `docs/ableton-mcp/source`, published on release
- Requires Node.js 22.13 or newer
