# Security model

Ableton MCP runs on one machine, with the privileges of the user who runs Live and the server.

## Transport

- The bridge listens on a Unix domain socket, by default `/tmp/cavi-ableton-mcp.sock`. It opens no TCP port.
- The socket file's permissions come from Live's umask. Any local process that can write to the socket can drive Live. Put it in a private directory if other local users are a concern: set `ABLETON_MCP_BRIDGE_SOCKET` for both Live and the server.
- The server speaks MCP over stdio to the client that launched it. It makes no network requests.

## Mutations

- Every Live mutation requires an observed state version, and plans by default.
- Execution needs a single-use confirmation token. Tokens are 24 random bytes, expire after 60 seconds, and are bound to the SHA-256 hash of the plan.
- The CLI stores pending tokens in `ABLETON_MCP_CONFIRMATION_DIR` (directory mode `0700`, files `0600`), named by the token's hash.
- The plan is rebuilt from a fresh observation at execution. If it no longer matches, execution is refused.

## Files

- `install` writes only the `CaviMcpBridge` directory. `uninstall` removes only that directory.
- Snapshot names are validated. Snapshots are capped at 4 MiB. The library refuses symlinked entries and never overwrites an existing snapshot.
- `search_local_splice_samples` needs an absolute root, searches only below it with a bounded depth and result count, and skips symlinks.
- Audio analysis runs `ffprobe` and `ffmpeg` with a `file,pipe` protocol whitelist.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** form on the repository's Security tab. Don't open a public issue.
