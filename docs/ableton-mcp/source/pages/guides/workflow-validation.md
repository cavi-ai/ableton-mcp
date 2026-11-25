# Validate against Live

The unit, bridge, documentation and package checks run with `npm test`, `npm run eval:core`, and `npm run verify:package`. They do not establish that guarded writes complete in a running Live session.

Use a separate saved scratch Live Set for native acceptance. Open that exact Set, stop playback and enable CaviMcpBridge. Commit the candidate first: the acceptance report identifies its source commit and refuses tracked working changes.

```bash
npm run acceptance:live -- --set /path/to/scratch.als --out .tmp/live-acceptance
```

The runner uses the actual CLI over MCP stdio and the real bridge. It does not open a different Set, save the Set, or start playback. The current canonical Set path must match `--set` before fixture writes.

The runner creates one uniquely named disposable MIDI track, one clip and a native Utility device. The planner, state checks, plan hash, single-use token and execution receipts apply to fixture setup and cleanup. Failed or uncertain operations are never replayed automatically. Cleanup removes only the uniquely named fixture track and checks the original tracks, mixer, devices, musical context and saved Set bytes. A cleanup error fails acceptance and leaves its details in the report for inspection.

Reports are written under the selected output directory. Keep them outside public commits. A passing run establishes the tested writes and exposed field checks at that commit; it does not establish audible quality, hidden plug-in equivalence, or support for every Live version. Listening feedback remains a separate acceptance step.
