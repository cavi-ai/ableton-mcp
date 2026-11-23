# Sliced agent sessions

One Live bridge can serve many `ableton-mcp serve` processes. Each process is one agent session. The host loads `tools/list` when that session starts, so the session must advertise only the tools that job needs.

Handlers stay in the one binary. A session advertises the union of named slices and refuses every other tool with `unknown tool`. CLI `call` is not a session: it can still invoke any handler.

## Select a slice union

Leave both selectors unset and `serve` advertises `observe`: Live identity, selection, orientation, tempo and meter, scale names, track, scene, and clip lists, and history.

```bash
ABLETON_MCP_TOOL_SLICES=observe,drums,transport ableton-mcp serve
```

Names are comma-separated. Unknown names, duplicates, and an empty list fail at startup. `ABLETON_MCP_TOOL_SLICES` and `ABLETON_MCP_TOOL_PROFILE` together also fail. Startup writes one stderr line with the slice names, tool count, and schema bytes:

```text
ableton-mcp session slices=observe,drums,transport tools=34 schemaBytes=32500
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

## Project adapter

A music project records which sessions exist. The manifest lives in that project, for example `.cavi/ableton-session.json`. It maps a role to slice names and a short brief. It does not copy tool schemas.

```json
{
  "roles": {
    "drums": {
      "slices": ["observe", "drums", "transport"],
      "brief": "Session drum clips only."
    },
    "mix": {
      "slices": ["observe", "mixer", "routing"],
      "brief": "Static levels and sends. No file export."
    }
  }
}
```

Validate `slices` against `ableton-mcp slices --json` before starting a session. An unknown name will fail at `serve`.

## Producer plugin sessions

The producer plugin reads that manifest. It does not register the Live tools and it does not execute Live writes.

The orchestrator session loads the plugin only. It stores the brief, the chosen role, and the handoff. It does not attach the functional catalog.

For each role, the plugin emits one subagent MCP entry. That entry is a separate `serve` process:

```json
{
  "mcpServers": {
    "ableton-drums": {
      "command": "ableton-mcp",
      "args": ["serve"],
      "env": { "ABLETON_MCP_TOOL_SLICES": "observe,drums,transport" }
    }
  }
}
```

The role session holds the tools, the dry-run plan, the confirmation token, and the readback. Several of these processes share the one bridge socket. Live applies their requests through one queue, and `stateVersion` still rejects a stale plan.
