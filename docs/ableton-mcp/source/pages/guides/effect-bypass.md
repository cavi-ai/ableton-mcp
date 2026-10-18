# Compare an effect with bypass

Use `compare-effect-bypass` through `get_producer_workflow` or its MCP prompt to hear one existing effect enabled and bypassed. Resolve the exact owner and device path, including nested racks, Returns and Main. Turning off an instrument or whole rack has a broader scope than bypassing one effect.

`get_device_activation_context` is read-only and preserves focus. It reports the unique binary `Device On` parameter, `localActive`, `effectiveActive`, enclosing rack activity, native automation context and strict recording/freeze flags. Missing, ambiguous or nonbinary controls are unsupported. Live's [effective activation](https://docs.cycling74.com/apiref/lom/device/) includes enclosing racks: a device can be locally on while a parent rack keeps it inactive. Do not enable parents automatically.

Plan `set_device_active` with fresh `expectedStateVersion` and an explicit boolean `active`. The plan binds native ancestry and parameter objects, local power, power automation, parent activation and edit context. Execution rechecks inside the undo step immediately before one power write. Active or unknown Device On automation, disabled power, recording/count-in and frozen or unknown owner state refuse. Already overridden power can be edited without resuming automation. Other automated controls can continue; the comparison does not freeze their values.

Inspect `valueWriteRequested`, `nativeReturned`, `verified`, `verification`, `after`, `device`, `error` and `observationError` independently. A no-op makes no write or undo step. Partial work remains without rollback or replay. Following a lost reply, inspect the exact current target before another action.

Keep the chosen result. Restoring the original local setting requires a fresh read and confirmation after checking current native identity, power/automation and parent activation against the last applied observation. Preserve intervening manual changes. Restoring a local setting does not restore envelopes, hidden state, tails or playback phase.

Playback and focus continue unchanged. Starting or stopping an audition follows its existing scoped workflow. Immediate switching does not guarantee equal loudness, click-free transitions, retained tails, timing or audible improvement; listen and ask what the user hears. Saving and destructive edits remain separate.
