# Quickstart

## Register the server with an MCP client

After [installing](installation.md), point the client at `ableton-mcp serve`:

```json
{
  "mcpServers": {
    "ableton": {
      "command": "ableton-mcp",
      "args": ["serve"]
    }
  }
}
```

The server speaks MCP over stdio. It publishes tools, resources and prompts.

## Try it from the shell

The CLI calls the same service:

```bash
ableton-mcp status --json
ableton-mcp resource ableton://set/tracks --json
ableton-mcp call list_devices --args '{"trackId":"track-0"}' --json
```

## Make a change

Every Live mutation is planned first, then executed.

1. Read the current `stateVersion` from `status` or `get_live_state`.
2. Call the tool with `expectedStateVersion`. The result is a dry-run plan with a `confirmation`.

```bash
ableton-mcp call set_tempo --args '{"expectedStateVersion":12,"tempo":124}' --json
```

3. Execute the reviewed plan with its single-use token and plan hash:

```bash
ableton-mcp call set_tempo --args '{"expectedStateVersion":12,"tempo":124,"dryRun":false,"confirmationToken":"<token>","planHash":"<hash>"}' --json
```

If the Set changed after the plan was made, execution is refused. [Guarded mutations](../guides/guarded-mutations.md) covers the full contract.

## Run without Live

```bash
ABLETON_MCP_FIXTURE=1 npm start
```

Fixture mode serves canned data over stdio. Use it to check client wiring.
