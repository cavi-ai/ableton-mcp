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

Set `ABLETON_MCP_TOOL_PROFILE=producer` in the MCP server environment. This profile advertises nine workflow tools plus `get_live_state`, `transport_stop` and `panic`. Existing `core` and `all` profiles remain available. The CLI's `call` command is independent of discovery profiles.

The `all` and `directory` profiles publish detailed result contracts. The `core` and `producer` profiles retain compact result summaries for discovery; the server and CLI still validate the full contracts on every tool call. Guarded tools must return a complete dry-run plan and confirmation, or an explicit execution-outcome receipt matching the requested mode. Invalid write receipts report an unknown outcome; inspect Live before retrying.

Use `ABLETON_MCP_TOOL_PROFILE=directory` for a surface where each native operation is listed individually for host review. It excludes the producer coordinator tools, including task execution and session advancement; hidden coordinator calls are rejected. The compact `producer` profile remains available for local specialist workflows. Choosing a profile does not establish directory approval or satisfy other submission requirements.

1. `get_production_context` captures consistent Live selection and musical context, returning a bounded preview and `contextRef`. It does not call a model.
2. `record_production_note` stores explicit intent or feedback. Pass its `noteRef` in a later task's `contextRefs` to reuse it.
3. `run_production_task` accepts `projectId`, `goal`, optional exact `scope` IDs, `constraints`, `contextRefs`, `intent` (`change` by default, or `inspect`), and `roles` (`creative`, `functional`, or `both`; default `functional`). It returns a `taskId`, short summary, result references and operation count.
4. `read_production_artifact` pages through detailed context, proposals and evidence. Its default page is 4,000 characters, with an 8,000-character maximum. Follow `nextOffset`; a truncated preview is not complete evidence.
5. `apply_production_operation` plans or executes one exact operation from a task.
6. `get_producer_workflow` finds workflow references with an optional `query`, lists all names/arguments when no selector is supplied, or renders one exact `workflow` with named string `arguments`. It does not observe Live, invoke a model or execute the workflow.

For example:

```bash
ableton-mcp call get_production_context --args '{"projectId":"my-song"}' --json
ableton-mcp call run_production_task --args '{"projectId":"my-song","goal":"Propose a less busy bass variation while preserving the original","roles":"both","scope":{"trackId":"track-2"}}' --json
```

Use IDs observed in your own Set. Read the task artifact to review proposed operations. By default, each specialist can make at most three model requests; a task permits at most eight additional observation, discovery or artifact reads. Specialists start with common tool schemas and can request `discover_production_tools` internally to retrieve up to four additional schemas by name or description. Creative discovery exposes reads only; functional operations must retain the original state-version and dry-run guard contract. This keeps the full catalog out of every model request while allowing new guarded tools to be discovered as the server grows.

To try experimental loading of schemas on demand, add `"toolDiscovery": "deferred"` to either role's runtime configuration. For example:

```json
{
  "functional": { "type": "ollama", "model": "your-installed-model", "toolDiscovery": "deferred" }
}
```

Deferred specialists start with Live state, selection and musical-context read schemas, plus any caller postcondition read schemas. The coordinator uses deterministic name and description retrieval to add at most two relevant read schemas and two guarded operation schemas within an 8,000-byte initial schema allowance. Caller criteria remain available even when larger than that allowance; the task input limit still applies. Retrieval supplies schemas, not target selection or permission to execute. A compact name index keeps every supported capability discoverable. Exact-name searches resolve that capability directly; keyword searches rank metadata matches with bounded pages. Additional schemas become available on the following turn. Each role loads its own schemas; creative and inspection tasks receive no operation schemas.

Deferred mode permits up to six model requests per role and eight schema discovery requests shared across the task, separately from the eight observation or artifact reads. The existing task deadline and input limits still apply. Exhaustion returns no executable proposal. Smaller initial schema context can require more model calls and latency; compare task outcomes before adopting this mode. Omit the setting or use `"toolDiscovery": "eager"` for the existing behavior. This setting affects specialist context only; it does not change MCP discovery profiles or the full advertised catalog.

Every specialist request identifies its current turn, maximum turns and remaining task reads in `progress`. Its completed-read ledger identifies observations, discovered schemas and artifact-page continuation offsets from earlier turns of that role. Specialists can use these results before requesting more data; a tool discovered in one turn becomes available in the next. Repeated Live reads still perform fresh observations and consume the read budget.

Continuation requests include only the immediately preceding validated reply from the same role and task, counted within the input-size budget. Ollama receives that actual reply as an assistant message followed by the current task and observations. ACP receives it in the bounded task packet. Neither runtime receives transcripts from older tasks automatically.

Ollama structured output restricts operations to the names and argument schemas supplied for that turn; creative requests permit no operations. The coordinator independently validates every proposal from either runtime, including argument schemas, scope and permissions.

Scope checks cover target arrays, nested targets and source/destination aliases at proposal time and again before applying a saved operation. A scoped MIDI source may be copied into new slots on the same track; its source ID must still match. Imported snapshot/template provenance is data, not an additional Live target. A track send may reference its Return without modifying that Return. Scoped writes whose targets cannot be resolved are rejected; song tempo and musical-context proposals retain their existing song-level behavior.

Scope IDs must be canonical and belong to the same owner. Malformed or conflicting IDs are rejected before observing Live or calling a specialist. Task scopes may specify only a clip or device ID; durable sessions still require its explicit track owner.

Confirmed native mutations return an additive `operationOutcome` object with `schemaVersion: 1`, `status`, `reason` and an `evidence` list of field names. The native receipt remains intact. The same outcome contract controls producer receipts and durable session advancement, even when declared field checks pass. Dry-run plans and reads do not acquire an execution outcome.

Each guarded native tool declares its receipt policy. Tools exposing execution-verification fields must supply their affirmative evidence; missing, contradictory or failed receipts remain `outcome_unknown`. Legacy versioned mutations retain their operation-response and state-readback guarantee. Request-only launches and active recordings remain `pending_postconditions`; UI actions awaiting user input remain `pending_user_action`. Handle-release evidence describes cleanup, not a completed performance. False audible-quality, hidden-state and equivalence limitations do not by themselves indicate execution failure.

All public tools declare four boolean annotations. Capturing production context persists an artifact and is an additive write. Tools that overwrite existing state are marked potentially destructive; additive creation tools are separate. Private project reads and notes are closed-world, while configured model providers and arbitrary file paths can cross that boundary. Annotations describe effects and never replace native confirmations or scope checks.

The initial functional toolkit includes native `set_track_volume_db` and `set_track_send_db` schemas alongside the raw mixer tool. Use these for dB targets after reading the exact fader or send in `get_track_mixer`; raw mixer values are not dB values. Less common operations still require discovery.

The returned `turnRefs` link each validated intermediate or final reply to its exact input artifact, including replies from tasks that exhausted a budget. Specialists may page their own previous replies as well as supplied context artifacts. Final role proposals remain in `resultRefs`. An exhausted task reports `stopReason` as `input_limit`, `read_limit` or `model_turn_limit`, with no executable operations. These references explain what was observed and proposed; they do not prove musical quality or guarantee that a configured model completes a workflow.

## Select workflow guidance for a task

Start with `get_producer_workflow` and a short keyword `query`, such as `"silent part"` or `"record Session take"`. Search is available in the `all` and `producer` profiles. It returns up to five candidates by default; `limit` accepts 1–20, and a query accepts 1–200 characters. Workflow names, descriptions and argument descriptions are the only matching sources. Matching ignores case and accents, skips common request words, and accepts word prefixes. It does not interpret intent, search full instructions or establish that a capability is available in the current Set.

Results retain the exact reference names, descriptions and argument definitions, adding `matchedTerms` to each candidate. More matched query terms rank ahead of fewer; name matches break coverage ties, and an exact workflow-name query ranks first. `totalMatches` counts metadata matches and `truncated` reports whether the result limit omitted any. Partial matches are possible: inspect `terms` and each candidate’s `matchedTerms`, then refine the query when the reference does not cover the brief. An empty list means no metadata matched, not that Ableton cannot perform the task. Search does not choose or execute a workflow.

Retrieve the selected exact name with its required string arguments before using its guidance. Search `query`/`limit` cannot be combined with `workflow`/`arguments`; `limit` requires a query. Omitting both search and retrieval selectors preserves the full listing.

An optional `workflow` on `run_production_task` supplies one bundled reference before either specialist's first model request. Use an exact `name` from `get_producer_workflow` and its named string `arguments`. For example, a bounded phase of `balance-mix` can use:

```json
{
  "projectId": "my-song",
  "goal": "Propose only the next level adjustment for the explicitly named bass track.",
  "roles": "functional",
  "scope": { "trackId": "track-2" },
  "workflow": {
    "name": "balance-mix",
    "arguments": { "request": "Lower the named bass to -12 dB while preserving other tracks", "mode": "autonomous" }
  }
}
```

Use the actual target ID. Required workflow arguments remain required; invalid names or arguments fail before Live observation or a model request. The task returns `workflowRef`, identifying the immutable selected arguments and rendered guidance in the private artifact store. The task artifact retains that reference. It records which guidance was supplied; it is not evidence that a complete workflow ran.

The reference guides only the requested bounded phase. It grants no tool access, changes no scope, and bypasses no confirmation, question, state or native identity guard. Specialists still need schema discovery for tools outside their initial set. Existing model-turn, read and input-size budgets include the selected guidance. A task with no workflow retains its usual context and behavior; the full workflow catalogue is never inserted automatically. An older workflow artifact supplied as context is data, not an instruction to run it again.

Task inputs are limited to 48,000 bytes and returned model JSON to 16,000 bytes. Detailed artifacts are capped at 2 MB each. Exhausted, stale or unanswered-question tasks have no executable operations. Main-session summaries and questions are bounded; full responses remain in the task artifacts.

## Plan, confirm and observe

`get_automation_capabilities` reports implementation boundaries and concrete handoffs without connecting to Live. `get_live_state.nativeApiSupport` separately reports what the running Live exposes. Specialists receive the shared production boundaries: multi-operation tasks are not atomic, envelope samples are not complete backups, exposed parameters do not verify hidden plug-in state, and automatic audible-quality verification is unavailable. A successful receipt or caller field check never replaces actual listening feedback.

Use `intent: "inspect"` for read-only specialist work. It returns `observed` and permits neither operation discovery nor operation proposals. A functional change task returns `proposed` only with concrete operations. An empty response returns `incomplete` unless fresh caller-owned postconditions all match, in which case it returns `no_change_needed` with a private `completionRef`. Model-selected checks and summaries cannot establish that no change is needed. Unavailable checks, unanswered questions, budget exhaustion and changed Live state retain their failure states. Incomplete durable proposals cannot advance to audition or acceptance; propose again after resolving the reported reason.

Optional `postconditions` on `run_production_task` let the caller define the required final outcome. For a bounded gain change:

```json
{
  "projectId": "my-song",
  "goal": "Lower the named bass to -12 dB while preserving other controls.",
  "scope": { "trackId": "track-2" },
  "postconditions": [{
    "tool": "get_track_mixer",
    "args": { "trackId": "track-2" },
    "path": ["volume", "decibels"],
    "expected": -12
  }]
}
```

Use actual IDs and values from the intended outcome. Each of one to eight checks names a real read-only tool, valid arguments, a field path of at most eight property names or array indexes, and an expected JSON value. An empty path compares the whole response. Checks use exact JSON equality, including value types; they do not infer tolerances or formatted display strings. Invalid tools, arguments or scope fail before Live observation or a model request. An empty check list is rejected.

The task returns `checkSource: "caller"` and an immutable `postconditionsRef`. Both roles receive the caller criteria, with their read schemas available without discovery. The saved criteria stay separate from observed facts and specialist suggestions. `suggestedCheckCount` counts checks in the final functional reply; those suggestions remain in its result artifact and must still pass tool and scope validation. They do not replace or add required caller checks. Without `postconditions`, the existing specialist-defined checks remain required and `checkSource` is `"specialist"`.

Review the criteria reference along with the original operation plan before confirmation. Plans and receipts identify the check source and criteria reference. Checks run only after the final operation of the task; a proposal or an earlier operation does not establish that the final criteria passed. A false caller check produces `postconditions_failed`; an unavailable observation produces `outcome_unknown`. Caller criteria do not bypass unanswered questions, budgets, state or native guards, and passing field checks does not establish audible quality. Supplying an old criteria artifact as context alone does not make it the new task's required outcome.

Call `apply_production_operation` with `projectId`, `taskId`, `operationIndex: 0` and the task's `expectedStateVersion`. It returns the original tool's plan reference, proposed arguments, plan hash and expiring confirmation token. Review the plan artifact, then repeat the same request with `dryRun: false`, `confirmationToken` and `planHash`.

The original tool validates its arguments and its native mutation guards. All mutations entering the same configured service share an execution queue. Other clients and manual edits still require the original bridge's state and identity checks; this queue is not a cross-process lock.

For subsequent operations, supply the preceding successful `receiptId` as `previousReceiptId` and use its returned state version. A changed observed Set identity or version invalidates the sequence. Reobserve and propose again after manual edits. Changes not reflected in the bridge's observed version still depend on the original operation's native identity checks; the coordinator does not add universal manual-edit detection.

Receipts distinguish applied operations, known rejections, pending user action or playback, failed declared postconditions and unknown outcomes. Final-operation checks compare explicit fields from read-only tools; state readback alone does not establish musical quality. An execution error or unavailable readback is never automatically retried. Inspect Live and the receipt before continuing. Successful earlier operations are not rolled back if a later operation fails; multi-operation proposals are not transactions.

An explicit negative native `verified`, `targetRetained` or `contextPreserved` result, or a requested write whose `nativeReturned` is false, produces `outcome_unknown` with `nativeVerificationFailed: true`. This applies to both direct native receipts and the original tool’s `observed` envelope. Passing caller field checks does not override that failure. Full attempted-write and error facts remain in `resultRef`; a durable session enters `needs_inspection` without advancing its operation cursor. Read the actual target and resume before proposing further work.

## Continue a production session

`start_production_session` saves a brief (`goal`, optional exact `scope`, `constraints`, `workflow` and caller `postconditions`) and the observed Set identity. Save the Set first: durable sessions use its file path to distinguish documents, so an unsaved Set or Save As requires a new session. `get_production_session` reads its bounded summary; omit `sessionId` to list twenty sessions in a project, following `nextOffset` for more. Full session revisions and their `previousRef` history are available through `read_production_artifact`.

Call `advance_production_session` with `projectId`, `sessionId`, the latest `expectedRevision`, and one `action`:

1. `propose` at `inspect` runs the creative specialist and saves alternatives. No Live operation executes.
2. `choose` at `choose` requires an `alternativeIndex` from that saved proposal. It records an explicit selection.
3. `propose` at `propose` runs the functional specialist with that selection and the saved brief. Its proposal determines the guarded operations.
4. `apply` at `apply` plans the next operation with `expectedStateVersion`. After reviewing the plan, repeat with `dryRun: false`, its `confirmationToken` and `planHash`. Each operation retains the original tool's checks. The coordinator advances its operation cursor only for an applied receipt; it does not roll back earlier changes.
5. At `audition`, use the existing playback/capture tools or listen in Live. `feedback` requires explicit user listening feedback in `text` and moves to `evaluate`. The session tool itself does not start playback or claim to hear audio.
6. `evaluate` requires a `decision` of `accept` or `revise`. Acceptance records the user's decision separately from operation receipts and field checks. Revision returns to `inspect`, preserving feedback as selected context. `audibleQualityVerified` remains false.

For a defined operational task, `roles: "functional"` starts directly with a functional proposal, without a creative alternative or creative runtime. Omit it or use `"both"` for the creative-then-functional flow above. Role selection does not authorize execution: every operation still requires its original dry run and confirmation.

To finish from observed criteria, explicitly start with `completion: "postconditions"` and nonempty caller `postconditions`. For example:

```json
{
  "projectId": "song",
  "goal": "Set the tempo to 100 BPM without changing other controls",
  "roles": "functional",
  "completion": "postconditions",
  "postconditions": [
    { "tool": "get_live_state", "args": {}, "path": ["tempo"], "expected": 100 }
  ]
}
```

After all operations are applied, or when a proposal requires no operation, this mode enters `evaluate` directly. `evaluate` with `decision: "accept"` rechecks the caller's criteria against fresh Live state. All must pass before the session becomes `complete` with `status: "postconditions_met"`. Failed checks stay in `evaluate`; `decision: "revise"` returns to inspection. Unknown or unverified writes still require inspection and a new proposal. The evaluation artifact records `basis: "postconditions"`; the session does not invent listening feedback or a user decision. These checks establish only the declared field comparisons, never audible quality. Use criteria that actually express the requested result. The default `completion: "listening"` continues to require explicit user feedback and a decision.

Use `resume` at the start of another conversation. It captures fresh Live context. A changed observed state discards the executable proposal and operation cursor; a different document path fails closed. Scoped observations compare the exact owner’s mixer, routing and device inventory, the exact clip's timing and MIDI notes or audio state, and the exact device's parameters. Clip and device scopes require their owning `trackId`. These observations detect relevant manual edits even when the bridge version is unchanged. They do not cover all possible Live properties, identical native-object replacements or hidden plug-in state; native mutation guards still apply. Playback and selection alone do not define target content. Old artifacts remain available for inspection, but are never replayed automatically. A session stores exact scope IDs; resolve the intended owner again after structural edits instead of guessing replacements.

Durable scopes accept ordinary/Group `track-N`, Return `return-N`, or Main `master` in `scope.trackId`. Resolve those IDs from `list_tracks` or `get_set_mixer`. Return and Main snapshots use the exact selected bus from `get_set_mixer`, not an ordinary-track mixer read. Returns also bind their output routing; Main’s hardware output is included in its mixer record. Ordinary/Group scopes include their routing snapshot. Two matching observation passes are required. A different Return’s mixer does not enter the selected Return’s target snapshot. Bus scopes may name an exact owned `deviceId`; clips require an ordinary-track owner, and bus clip scopes fail before observation or a model request. Shared Return mixer operations must match the declared owner; `set_master_mixer` requires Main scope when a track owner is specified. Broader operations still need their own permitted scope and original native confirmation.

Every durable session also binds the song’s observed tempo, meter, configured key/scale, quantization, groove pool and Arrangement loop. This applies with or without a track scope. A manual change to these settings requires resume and a new proposal even when the bridge version is unchanged. Song observations must agree with the captured context and across both target passes; a changing observation fails before saving a session revision. With unchanged Set identity, selection and playback alone do not change the target snapshot. Sessions captured without song observations require a new proposal on their first resume.

Every update requires the latest session revision. Publishing a revision uses an exclusive filesystem link so competing processes cannot both advance the same revision. Before execution, a pending revision is saved. If the process exits during execution or the outcome is uncertain, resume requires inspection and a new proposal. It cannot infer whether an interrupted operation ran from the missing reply.

In `audition`, `evaluate` and `complete`, a forward bridge-version change can retain the completed task, receipts, selection and feedback when the document path, Set fingerprint and scoped content still match. This lets playback and stop operations advance the bridge version without discarding completed work. `resume`, `feedback` and `evaluate` capture a new observation basis; `stateChanged` may be true while the phase is retained. The original task and execution receipts remain immutable. Resuming a previously completed session always returns to `evaluate` with status `requires_evaluation` when its content still matches, even without a bridge-version change. Its earlier acceptance remains in revision history, while the current revision clears `evaluationRef` and `userDecision`. Acceptance still rechecks required postconditions, including playback-dependent criteria. A version change during those checks requires a retry. This is a scoped content comparison, not proof that every property of the Set is unchanged. Content changes, fingerprint changes, version regressions and interrupted execution still require inspection and a new proposal. Executable phases remain strict about every version change.

Session history stays in immutable private artifacts. Model requests select the current observation, chosen alternative and latest relevant feedback; they do not load the session's full history. The existing per-task model, read and byte limits also apply to session proposals. Both roles must be configured for the default creative-then-functional flow; functional-only sessions require only the functional runtime.

## Artifact storage

`ABLETON_MCP_PRODUCER_DIR` defaults to `~/.cavi/ableton-mcp/producer`. Each `projectId` has immutable, content-addressed JSON artifacts. Project IDs are namespaces, not authentication boundaries. Artifact files are created with owner-only permissions and checked against their SHA-256 IDs on read.

Specialists receive bounded previews and can request pages of artifacts explicitly included in their task. Full transcripts, parameter inventories and note arrays stay out of the main tool response. Intent and feedback remain separate from observed Live facts. Context is assembled afresh for each task; old model transcripts are not replayed automatically.

Artifacts persist until removed by the user. Delete an obsolete project directory while no task for it is running to remove its stored context. Back up useful intent and feedback first. Nothing from this store is added to the Live Set or Git repository automatically.
