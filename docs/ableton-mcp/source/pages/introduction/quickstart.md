# Quickstart

## Register the server with an MCP client

Point the client at `cli.mjs serve` in your checkout. Use an absolute path:

```json
{
  "mcpServers": {
    "ableton": {
      "command": "node",
      "args": ["/path/to/ableton-mcp/apps/ableton-mcp/src/cli.mjs", "serve"]
    }
  }
}
```

The server speaks MCP over stdio. It publishes tools, resources and prompts.

## Try it from the shell

The CLI calls the same service:

```bash
npm run cli -- status --json
npm run cli -- resource ableton://set/tracks --json
npm run cli -- call list_devices --args '{"trackId":"track-0"}' --json
```

## Make a change

Every Live mutation is planned first, then executed.

1. Read the current `stateVersion` from `status` or `get_live_state`.
2. Call the tool with `expectedStateVersion`. The result is a dry-run plan with a `confirmation`.

```bash
npm run cli -- call set_tempo --args '{"expectedStateVersion":12,"tempo":124}' --json
```

3. Execute the reviewed plan with its single-use token and plan hash:

```bash
npm run cli -- call set_tempo --args '{"expectedStateVersion":12,"tempo":124,"dryRun":false,"confirmationToken":"<token>","planHash":"<hash>"}' --json
```

If the Set changed after the plan was made, execution is refused. [Guarded mutations](../guides/guarded-mutations.md) covers the full contract.

## Run without Live

```bash
ABLETON_MCP_FIXTURE=1 npm start
```

Fixture mode serves canned data over stdio. Use it to check client wiring.
