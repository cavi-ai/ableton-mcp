# Sliced agent sessions

One Live bridge can serve many `ableton-mcp serve` processes. Each process is one agent session. The host loads `tools/list` when that session starts, so the session must advertise only the tools that job needs.

Handlers stay in the one binary. A session advertises the union of named slices and refuses every other tool with `unknown tool`. CLI `call` is not a session: it can still invoke any handler.

## Select a slice union

Leave both selectors unset and `serve` advertises `observe`: Live identity, selection, orientation, tempo and meter, scale names, track, scene, and clip lists, and history.

```bash
ABLETON_MCP_TOOL_SLICES=observe,drums,transport ableton-mcp serve
```

Names are comma-separated. Unknown names, duplicates, and an empty list fail at startup. `ABLETON_MCP_TOOL_SLICES` and `ABLETON_MCP_TOOL_PROFILE` together also fail. Startup logs the slice names, tool count, and base schema size on stderr.

```text
ableton-mcp session slices=observe,drums,transport tools=34 baseSchemaBytes=32500
```

`ableton-mcp slices --json` lists every slice, its tools, its resources, and its prompts. Slice sessions currently advertise no workflow prompts. Prompt text remains available through `ableton-mcp prompt` and through the legacy `all` and `producer` profiles.

A custom union is allowed. The stock unions below are the ones kept inside 63 tools and 57,000 bytes of advertised schema. A larger union still starts; the log line is how you see the cost.

| Role | Slices |
|---|---|
| `arrange` | `observe`, `arrangement`, `transport` |
| `harmony` | `observe`, `voicing` |
| `drums` | `observe`, `drums`, `transport` |
| `mix` | `observe`, `mixer`, `routing` |
| `sound` | `observe`, `devices`, `racks` |
| `record` | `observe`, `recording`, `transport` |
| `files` | `observe`, `files` |

`midi` is note reading and editing. `voicing` is scale planning and chord transformation. Together with `observe` they exceed the stock budget, so a harmony session and a note-edit session stay separate. `compare` is instrument comparison, separate from `devices` for the same reason. `feel`, `envelopes`, `audio`, `library`, and `session` are available to a project union and are not part of a stock role.

`observe` is not added automatically. A session that omits it does not receive track lists or Live identity.

## Legacy profiles

`ABLETON_MCP_TOOL_PROFILE` remains an explicit alias:

- `all` advertises every tool, including producer coordination, and every workflow prompt.
- `core` advertises the frozen 63-tool catalog.
- `directory` advertises native tools without producer coordinators.
- `producer` is the temporary specialist alias. Functional sessions use slices. See [Production specialists](production-specialists.md).

## Configure role sessions

Add one MCP server entry per role in your host configuration. Each entry starts a separate `ableton-mcp serve` process with its own slice union. Leave `ABLETON_MCP_TOOL_PROFILE` unset in those server environments. For a host that uses an `mcpServers` map, two role entries look like this.

```json
{
  "mcpServers": {
    "ableton-drums": {
      "command": "ableton-mcp",
      "args": ["serve"],
      "env": { "ABLETON_MCP_TOOL_SLICES": "observe,drums,transport" }
    },
    "ableton-mix": {
      "command": "ableton-mcp",
      "args": ["serve"],
      "env": { "ABLETON_MCP_TOOL_SLICES": "observe,mixer,routing" }
    }
  }
}
```

In hosts with per-agent MCP settings, assign each agent only its role's entry and give it a brief. For example, assign `ableton-drums` to the agent working on Session drum clips. Reconnect the host after changing an entry so it discovers the new catalog.

Keep each dry-run plan, confirmation token, and readback with the session that made the plan. These processes share one bridge socket. Live applies their requests through one queue, and `stateVersion` rejects a stale plan.
