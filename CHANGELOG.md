# Changelog

## 0.1.0 — unreleased

- MCP server, CLI, and Ableton Live Remote Script bridge
- Guarded mutations: dry-run plans, state versions, single-use confirmation tokens
- Read-only MCP resources and producer workflow prompts
- Optional NKS preset catalog: `npm run catalog:inventory` builds it from `config/plugins`; `search_presets` searches every product unless `productSlug` is given
- Presets no longer found on disk are flagged `missing` and hidden from search; tags and favorites are kept
- Optional NKS artwork pipeline
- Environment variables use the `ABLETON_MCP_` prefix
- Versioned documentation under `docs/ableton-mcp/source`, published on release
- Requires Node.js 22.13 or newer
