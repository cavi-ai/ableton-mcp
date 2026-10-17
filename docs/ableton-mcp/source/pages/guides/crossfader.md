# Prepare crossfader parts

Use `crossfade-parts` through `get_producer_workflow` in the `all` profile, or retrieve its MCP prompt. Name the intended A/B parts and distinguish setup from a requested Main position move.

## Inspect the complete bus

`get_crossfader_context` reads the Main value, bounds, enabled and automation state, plus all ordinary, Group and Return assignments and Group relationships. Unsupported native properties stay explicit. Inspection changes no mixer controls, transport or selection.

The Main crossfader affects every assigned member. Existing members outside the named pair remain relevant; a shared Return can include tails from several parts. Inspect the intended tracks' routes and mute/solo state through the existing mixer/routing tools. A Group and its descendants can introduce multiple stages. Choose the intended mixer stage explicitly instead of assigning an entire hierarchy automatically. See [Live's crossfader documentation](https://www.ableton.com/en/live-manual/12/mixing/#using-lives-crossfader).

## Set assignments, then consider movement

Plan `set_crossfader_state` with `assignments`, containing one to 64 unique `{trackId, side}` entries. Sides are `A`, `none` or `B`; target IDs identify ordinary tracks, Groups or Returns. Main is not an assignment target. Only named assignments change. Assignment changes at the current Main position can change sound immediately.

The mutation requires recording/count-in off, known assignment readback for all members, and an enabled continuous Main parameter with known inactive automation. Do not stop recording or disable automation to bypass refusal. Both assignment and position confirmations bind native owners, mixers, the Main parameter and complete observed membership. Manual changes invalidate the plan.

After confirming setup, require `verified:true` and inspect observed membership. A separate explicitly requested Main move uses `position` with a new confirmation. Positions range from native -1 left through 0 center to +1 right within observed bounds, without clamping. The tool refuses combining assignments and position in one call. Other members retain their assignments and therefore also respond to Main movement.

A position change is an immediate request with later readback, not a timed fade, beat scheduling or an atomic audio transition. Native values are checked within 0.000001. Curve settings are not changed or verified. Equal numerical position does not prove equal power, loudness or audible balance. No volume, pan, send, routing, playback or selection changes are requested.

## Inspect partial results

The result separates `verified` and `partial` from `requestedAssignmentTrackIds` and `positionWriteRequested`. Matching assignments and positions need no write. Native requests are issued once; later callbacks only observe their application. A failure can leave some assignments or a position change applied. No automatic rollback, undo or replay follows.

After a lost or partial response, re-read `get_crossfader_context`, mixer and transport state. Resolve manual edits and continue only missing authorized work with fresh IDs and confirmation. Do not automatically restore stale values. Native readback does not prove the user heard a transition. Saving and recording remain separate operations.
