# Validate production workflows

The unit, bridge, documentation and package checks run with `npm test`, `npm run eval:core`, and `npm run verify:package`. They do not establish that a configured model can complete a production task in a running Live session.

Use a separate saved scratch Live Set for model and native workflow acceptance. Open that exact Set, stop playback, enable CaviMcpBridge, and choose an already installed local Ollama model. Commit the candidate first: the acceptance report identifies its source commit and refuses tracked working changes.

```bash
npm run acceptance:live -- --set /path/to/scratch.als --model your-installed-model --discovery both --out .tmp/live-acceptance
```

`--discovery` accepts `eager`, `deferred`, or `both` (the default). The runner uses the actual CLI over MCP stdio, the real bridge and the configured local model. It does not download models, open a different Set, save the Set, or start playback. The current canonical Set path must match `--set` before fixture writes.

The runner creates one uniquely named disposable MIDI track, one clip and a native Utility device. Each mode must complete four bounded tasks:

1. Set the track's volume in dB while preserving its other mixer controls.
2. Change one MIDI note's velocity while preserving its identity and other properties.
3. Change an exposed device parameter while preserving other parameter values.
4. Propose a durable task, restart the MCP process, resume the saved proposal, execute through the original confirmation guards, and freshly evaluate caller-owned criteria.

The same planner, state checks, plan hash, single-use token and execution receipts apply to fixture setup, task operations and cleanup. Failed or uncertain operations are never replayed automatically. Cleanup removes only the uniquely named fixture track and checks the original tracks, mixer, devices, musical context and saved Set bytes. A cleanup error fails acceptance and leaves its details in the report for inspection.

Reports and private task artifacts are written under the selected output directory. Keep them outside public commits. A passing run establishes the tested model, mode, tasks and exposed field checks at that commit; it does not establish audible quality, hidden plug-in equivalence, or support for every Live version. Listening feedback remains a separate acceptance step.
