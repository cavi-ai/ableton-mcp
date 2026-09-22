# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's "Report a vulnerability" form on the repository's Security tab. Do not open a public issue.

## Scope

- The Remote Script bridge listens on a Unix domain socket, default `${TMPDIR}/cavi-ableton-mcp.sock`, overridable with `CAVI_MCP_BRIDGE_SOCKET`. It opens no TCP port.
- Every Ableton mutation requires an observed state version, defaults to a dry-run plan, and executes only with a short-lived, single-use confirmation token.
- `ableton-mcp install` writes only the `CaviMcpBridge` directory into the Remote Scripts destination; `uninstall` removes only that directory.
