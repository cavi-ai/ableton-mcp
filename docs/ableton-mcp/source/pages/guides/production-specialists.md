# Production specialists

Production specialists keep detailed musical and operational context outside the main conversation. The creative role proposes musical directions and alternatives. The functional role requests bounded observations and proposes concrete tool operations. A deterministic coordinator stores their inputs, outputs and evidence as private artifacts. Neither role executes Live changes.

## Configure a runtime

Specialists are optional. Set `ABLETON_MCP_PRODUCER_CONFIG` to a JSON object with a `creative` entry, a `functional` entry, or both. Each role has its own runtime configuration. Nothing starts until `run_production_task` requests that role.

For an installed local Ollama model:

```json
{
  "creative": { "type": "ollama", "model": "your-installed-model" },
  "functional": { "type": "ollama", "model": "your-installed-model" }
}
```

Ollama defaults to `http://127.0.0.1:11434`. An optional `endpoint` must be a local origin. A remote HTTPS origin or a cloud model requires `allowRemote: true`. Before sending project context without that opt-in, the adapter checks model-only metadata for a local model format and modelfile, rejecting cloud aliases and unrecognized metadata. The configured Ollama server is a trusted boundary. The adapter requests schema-constrained JSON and never downloads models or falls back to a different provider. Configure a model that supports the requested structured output. This adapter sends text and structured observations, not audio or images; it does not establish that the model has heard a passage.

For a configured ACP v1 agent:

```json
{
  "functional": {
    "type": "acp",
    "command": "/path/to/your-acp-agent",
    "args": [],
    "env": ["PROVIDER_API_KEY"]
  }
}
```

Use the command and arguments documented by your ACP agent. Provider and model selection belong to that agent's configuration. `env` names environment variables to pass through; it does not contain secret values. Only basic process variables and explicitly named variables are forwarded. The agent may also use credentials from its own profile. No credentials are created by this feature, and there is no automatic cloud fallback.

ACP receives a fresh session for each bounded request, an isolated temporary working directory, no MCP servers and no client filesystem or terminal capabilities. Permission requests are denied. Only the final agent message is collected; thought streams are not forwarded. ACP is a trusted subprocess connection, not an operating-system sandbox: use an agent whose own permissions you trust. A configured executable can access the machine independently of ACP client capabilities.

Each runtime accepts `timeoutMs` from 1,000 to 180,000; the default is 60,000. A complete production task also has a 180,000 ms deadline, with at most two tasks active in one service. Cancellation stops pending model work and terminates the owned ACP process group on POSIX, or requests process-tree termination on Windows. Teardown is bounded independently of inherited process pipes. Specialist model turns do not hold the MCP control queue, so stop requests remain dispatchable.

## Keep the main tool catalog small

Set `ABLETON_MCP_TOOL_PROFILE=producer` in the MCP server environment. This profile advertises five workflow tools plus `get_live_state`, `transport_stop` and `panic`. Existing `core` and `all` profiles remain available. The CLI's `call` command is independent of discovery profiles.

1. `get_production_context` captures consistent Live selection and musical context, returning a bounded preview and `contextRef`. It does not call a model.
2. `record_production_note` stores explicit intent or feedback. Pass its `noteRef` in a later task's `contextRefs` to reuse it.
3. `run_production_task` accepts `projectId`, `goal`, optional exact `scope` IDs, `constraints`, `contextRefs`, and `roles` (`creative`, `functional`, or `both`; default `functional`). It returns a `taskId`, short summary, result references and operation count.
4. `read_production_artifact` pages through detailed context, proposals and evidence. Its default page is 4,000 characters, with an 8,000-character maximum. Follow `nextOffset`; a truncated preview is not complete evidence.
5. `apply_production_operation` plans or executes one exact operation from a task.

For example:

```bash
ableton-mcp call get_production_context --args '{"projectId":"my-song"}' --json
ableton-mcp call run_production_task --args '{"projectId":"my-song","goal":"Propose a less busy bass variation while preserving the original","roles":"both","scope":{"trackId":"track-2"}}' --json
```

Use IDs observed in your own Set. Read the task artifact to review proposed operations. Each specialist can make at most three model requests; a task permits at most eight additional observation, discovery or artifact reads. Specialists start with common tool schemas and can request `discover_production_tools` internally to retrieve up to four additional schemas by name or description. Creative discovery exposes reads only; functional operations must retain the original state-version and dry-run guard contract. This keeps the full catalog out of every model request while allowing new guarded tools to be discovered as the server grows.

Task inputs are limited to 48,000 bytes and returned model JSON to 16,000 bytes. Detailed artifacts are capped at 2 MB each. Exhausted, stale or unanswered-question tasks have no executable operations. Main-session summaries and questions are bounded; full responses remain in the task artifacts.

## Plan, confirm and observe

Call `apply_production_operation` with `projectId`, `taskId`, `operationIndex: 0` and the task's `expectedStateVersion`. It returns the original tool's plan reference, proposed arguments, plan hash and expiring confirmation token. Review the plan artifact, then repeat the same request with `dryRun: false`, `confirmationToken` and `planHash`.

The original tool validates its arguments and its native mutation guards. All mutations entering the same configured service share an execution queue. Other clients and manual edits still require the original bridge's state and identity checks; this queue is not a cross-process lock.

For subsequent operations, supply the preceding successful `receiptId` as `previousReceiptId` and use its returned state version. A changed observed Set identity or version invalidates the sequence. Reobserve and propose again after manual edits. Changes not reflected in the bridge's observed version still depend on the original operation's native identity checks; the coordinator does not add universal manual-edit detection.

Receipts distinguish applied operations, known rejections, pending user action or playback, failed declared postconditions and unknown outcomes. Final-operation checks compare explicit fields from read-only tools; state readback alone does not establish musical quality. An execution error or unavailable readback is never automatically retried. Inspect Live and the receipt before continuing. Successful earlier operations are not rolled back if a later operation fails; multi-operation proposals are not transactions.

## Private context

`ABLETON_MCP_PRODUCER_DIR` defaults to `~/.cavi/ableton-mcp/producer`. Each `projectId` has immutable, content-addressed JSON artifacts. Project IDs are namespaces, not authentication boundaries. Artifact files are created with owner-only permissions and checked against their SHA-256 IDs on read.

Specialists receive bounded previews and can request pages of artifacts explicitly included in their task. Full transcripts, parameter inventories and note arrays stay out of the main tool response. Intent and feedback remain separate from observed Live facts. Context is assembled afresh for each task; old model transcripts are not replayed automatically.

Artifacts persist until removed by the user. Delete an obsolete project directory while no task for it is running to remove its stored context. Back up useful intent and feedback first. Nothing from this store is added to the Live Set or Git repository automatically.
