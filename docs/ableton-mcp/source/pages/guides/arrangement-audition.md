# Audition an Arrangement passage

Retrieve `audition-arrangement-passage` through `get_producer_workflow` or open its MCP prompt. Describe the passage, intended tracks and playback action. The workflow resolves exact track references and quarter-note song-time boundaries without changing selection. A named locator alone does not establish an ending, and the current meter does not establish a bar map across meter changes.

## Start a loop

`audition_arrangement_passage` requires the `all` profile and the updated Remote Script. Supply an explicit increasing `startBeats`/`endBeats` range of at most 512 beats, one to 64 ordinary `trackIds`, and fresh `expectedStateVersion`. Transport must be stopped, recording off and pending clip launches resolved. Stop ongoing playback only when the intended interruption is authorized; do not silently disable recording or disarm other tracks.

Review its dry-run plan and global-playback warning, then execute the unchanged confirmed plan. One native callback rechecks the document and observed controls, sets the Arrangement loop and playhead, returns only the named tracks from Session override, and requests playback. Verification waits for up to three later Live callbacks for applied controls without reissuing commands. Other tracks retain their ordinary-track override state, but global playback can make their material sound. Group tracks are refused because their return control also affects descendants; resolve intended ordinary children explicitly. The underlying [Single Track Back to Arrangement control](https://docs.cycling74.com/apiref/lom/track/#back_to_arranger) is separate from the whole-Set button.

The plan includes current loop/playhead, recording modes, track/mixer identity, playing Session clip references, pending launches and overlapping Arrangement clip metadata. It does not bind every note or device state. Bounds are 256 total tracks, 16384 Session slots and 4096 Arrangement clips across requested tracks; excessive scope is refused without sampling. A bridge reload or document change invalidates the plan even when the path and state version match.

## Interpret the receipt

Require `observed.started:true` and inspect its `verification`: loop bounds, returned tracks, unchanged track topology, preserved unrelated ordinary-track overrides, recording off and observed playhead within the window. Playback continues looping until stopped. The action does not mute, solo, arm, save or record, and stored-state verification does not establish audible output or sound quality.

A partial or unverified result may have changed controls, returned some tracks, or started playback. The receipt reports the failed phase and actual observed controls when available. Inspect current state before retrying. Returning a track cannot restore the earlier Session clip phase merely by toggling a flag, so no automatic playback rollback is claimed.

## Compare, refine and stop

For [instrument comparisons](instrument-comparison.md), resolve the pair through its current handle and select the intended sound before starting the passage. Return both tracks only when that scope is intended. Once the loop is running, switch the comparison's mutes without stopping and repositioning for each choice. Do not launch Arrangement clip IDs as Session clips.

For a requested global audition stop, use `transport_stop`; loop settings remain in place. A request to stop only one part requires a scoped action. Restore earlier loop settings, reposition or relaunch Session clips only when requested and after checking for intervening edits against the actual earlier baseline. Relaunching does not recover an earlier playback phase. Notes, devices, routing, selection and unrelated work are preserved. Requested recording or measurement uses the separate [Live audio capture](live-audio-capture.md) workflow.
