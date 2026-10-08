# Changelog

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
