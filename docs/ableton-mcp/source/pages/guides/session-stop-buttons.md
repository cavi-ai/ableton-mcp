# Keep a part playing across a scene

An empty Session slot with a stop button can stop that track when its scene launches. An unarmed empty slot without the button can leave the track's current part playing. Live exposes this through [ClipSlot.has_stop_button](https://docs.cycling74.com/apiref/lom/clipslot/).

## Change one exact empty slot

In the `all` profile, read `get_scene_launch_context` for the intended scene and inspect every track. Resolve the exact ordinary track and empty `track-N:clip-M` slot. A selected scene or matching name alone is insufficient.

Plan `set_clip_slot_stop_button` with the exact `trackId`, `clipId`, desired boolean `hasStopButton` and fresh `expectedStateVersion`. Use `false` only when the intended section should leave that track's current part playing; `true` restores the stop button. This changes future launch behavior and does not launch a scene, stop current playback or move selection.

The plan includes the complete native row and recording context. Confirm its unchanged token and hash. Native execution rechecks the document, scene, tracks, slots, playing-clip identities and row metadata, changes only the requested flag in one undo step, and requires readback. The tool rejects populated or Group slots, frozen targets, existing recording, pending target launches, unavailable stop-button state and unchanged values.

## Inspect before launching

Require `observed.verified`, then independently read the row again. Its `emptyContinueTrackIds` or `emptyStopTrackIds` should reflect the requested choice. Inspect Groups, armed empty tracks, pending launches, recording and scene/global musical controls before a separately authorized launch.

Removing a stop button does not guarantee that an armed empty slot cannot record. Live's launch preference is not fully exposed. This tool neither changes arms nor proves what the listener hears, follow-action behavior or uninterrupted audio. Keep a performance's unrelated controls unchanged.

After a lost reply, inspect the actual row before retrying. A failed write attempts to restore the flag only while native ownership is confirmed; rollback failures or uncertain ownership are explicit. Preserve intervening changes. Restore an owned setting only when that restoration is intended and the actual slot still matches the last observation; never use global undo to clean up a row.

See [Build a Session scene](session-scene-building.md) and [Session scene playback](scene-launch.md).
