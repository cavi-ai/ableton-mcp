# Hold a Session clip

Use `perform-session-clip` through `get_producer_workflow` in the `all` profile, or retrieve its MCP prompt. Name the existing Session clip and intended hold duration. The workflow uses native press/release calls for Gate and Repeat; ordinary one-shot launching remains available through `launch_clip`.

## Prepare the intended clip

Read `get_clip_timing` and current transport/recording context. Launch mode must already be Gate or Repeat. An authorized mode change uses `set_clip_timing` while playback is stopped; configuring it does not perform a hold.

`hold_session_clip` requires running global playback, recording off, an unarmed/unfrozen target and no pending track launch. It refuses another playing Session clip on that track and reserves the native track while a hold or failed release is unresolved. An already-playing target needs `allowPlaying:true` within the requested scope. The plan binds native track, slot and clip identity, launch settings and current context. No mute, solo, routing, mode or global transport changes are requested.

Starting a Session clip can override its track's Arrangement playback. The tool does not return the track to Arrangement afterward. Existing launch quantization, follow actions and other sounding parts still apply. Concurrent manual/controller input on the same launch button cannot be attributed to a particular source and may be released with the tool's press.

## Perform and inspect

Plan `hold_session_clip` with exact `trackId`, `clipId`, fresh `expectedStateVersion` and `durationSeconds` from 0.25 to 8. Confirm the unchanged plan. Retain `holdId` immediately. Live requests release on its display ticks after the wall-clock duration, independently of the client connection. This is neither beat scheduling nor a hard real-time deadline; delayed display ticks can delay release.

Read `get_session_clip_hold` to inspect the handle, or omit `holdId` to list handles after reconnecting. The result separates press/release command receipts from `isPlaying` and `isTriggered` snapshots. `buttonStateVerified:false` means the workflow has no raw held-button readback. A complete status means the release call returned, not that a particular musical passage or audible output was verified. Quantization can delay a launch beyond a short hold.

Gate release may stop the clip; Repeat may continue playing. Release does not globally stop transport, stop another clip or restore previous launch settings. This uses the native [Clip press/release API](https://docs.cycling74.com/apiref/lom/clip/#set_fire_button_state).

## Cancel and resume

Use `finish_session_clip_hold` with `cancel:true` and a fresh guarded plan for early release. It addresses the retained native clip, never a replacement at an old index. Current IDs are reported when track positions change. Playback, recording, arm, mode or ownership changes interrupt the hold and request release; failed releases remain `cleanup_failed` with explicit errors. An explicit cancel can retry a failed release against the same handle.

A failed release retains its handle and track reservation until an explicit cancel retry succeeds. Finishing a released terminal handle removes its runtime evidence. Inspect errors and actual playback first. At most four active holds and sixteen retained handles are supported. Bridge reloads or Live restarts can remove handles; missing handles do not prove release. Preserve partial state and inspect current clips before another press. Do not replay a lost start, undo the performance or clear unrelated clips as cleanup. Saving and recording remain separate operations.
