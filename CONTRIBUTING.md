# Contributing

## Setup

Install Node.js 22.13 or newer, Python 3, ImageMagick 7 (`magick`), and ffmpeg, then:

```bash
npm ci
npm test
```

`npm test` must pass on a clean checkout before a pull request is opened. Ableton Live is not required for the test suites; `ABLETON_MCP_FIXTURE=1 npm start` serves fixture data over stdio.

## Where changes go

- MCP tool schemas: `apps/ableton-mcp/src/tool-contracts.mjs`
- MCP tool behavior: `apps/ableton-mcp/src/tool-service.mjs` and the module it delegates to
- Live-side operations: `ableton/Remote Scripts/CaviMcpBridge/bridge.py`, advertised in `capabilities.json`. Tests fail if a dispatched method is missing from `capabilities.json`, or if a contracted tool has no handler.
- Documentation: `docs/ableton-mcp/source`. After changing a tool contract, run `npm run docs:tools` to regenerate `reference/tools.md`.
- Tests: `apps/ableton-mcp/test`, `packages/nks-pipeline/test`, `ableton/Remote Scripts/CaviMcpBridge/tests`, `scripts/docs`

## Rules for changes

- Every change ships with a test that fails without it.
- Every Ableton mutation takes `expectedStateVersion`, returns a plan when `dryRun` is omitted or true, and executes only with the single-use `confirmationToken` from that plan.
- When Live's public API does not expose a property or setter, report the boundary and fail closed. Do not simulate an unsupported write.
- Do not commit vendor presets, samples, artwork, logos, or product masters.
- Keep a pull request to one concern.

## Commits

Use Conventional Commit prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `test:`.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
