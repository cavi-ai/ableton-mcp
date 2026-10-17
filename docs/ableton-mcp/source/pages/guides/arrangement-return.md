# Return tracks to Arrangement

Use `resume-arrangement-tracks` through `get_producer_workflow` in the `all` profile, or retrieve its MCP prompt, to hand named parts back from Session performance to Arrangement. The existing global playback and loop settings stay in place; the tool does not seek. A running playhead continues to advance.

## Resolve the handoff

Read `list_tracks`, `get_scene_launch_context`, `get_transport_recording_context` and the intended tracks' `list_arrangement_clips`. Returning can stop the selected tracks' Session clips and expose Arrangement material or silence at the current playhead. It does not record or copy the Session performance. The command acts immediately; it is not scheduled to a bar boundary.

Choose one to 64 exact ordinary tracks. Group headers are refused because their native return affects descendants. Resolve a Group request into the intended ordinary descendants explicitly. Other ordinary tracks retain their overrides; a parent Group indicator can change as a derived consequence.

Recording/count-in, armed/frozen targets, pending target launches and active or failed-release target holds are refused. For an authorized early hold release, use `finish_session_clip_hold` with `cancel:true`, inspect the actual release result, then plan the return. Do not silently stop recording or change arms or freezing to bypass refusal.

## Return and inspect

Plan `return_tracks_to_arrangement` with `trackIds` and fresh `expectedStateVersion`. Review the exact native tracks, current Session clip, Arrangement clip spans and global controls. Confirm the unchanged plan. Advancing song time does not invalidate an otherwise stable running plan. An already-returned track requires no write.

The result separates `requestedTrackIds` from `returned` and `partial`. Later callbacks inspect target return state, native identity, unrelated overrides, recording and global controls without reissuing commands. `playheadWriteRequested:false` reports that no seek was requested; observed song time can advance naturally. Readback does not prove audible output or phase alignment.

After a partial or lost reply, inspect current track/Session and transport state before another mutation. Some tracks may already have returned. Continue only the missing intended action with fresh IDs and a new confirmation. Never automatically undo, relaunch Session clips or replay an uncertain batch. Earlier Session phase cannot be restored by toggling a flag. Saving remains separate.

For an authorized passage restart that changes the loop and playhead and starts playback, use [Arrangement audition](arrangement-audition.md).
