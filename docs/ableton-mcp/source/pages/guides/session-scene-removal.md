# Remove a Session scene

Retrieve `remove-session-scene` through `get_producer_workflow` or its MCP prompt when the user explicitly wants one Session row removed. Resolve the exact row using current selection, scenes and `get_scene_launch_context`. Making a comparison does not authorize deleting rejected alternatives. Preserve the original and chosen versions unless their removal is explicitly requested.

A scene spans every ordinary track and Group slot in its row: clips, empty stop buttons and tempo/meter overrides. Exposed material reads do not back up hidden expression or clip envelopes.

## Plan the deletion

Use `delete_session_object` with `targetType: "scene"`, the exact `targetId` and fresh `expectedStateVersion`. A populated row requires `allowContent: true` within explicit content authority. The updated bridge binds the native Song, tracks, scenes, slots and clips, complete exposed Session material, native playing flags and track playback indices. It rechecks at undo entry before one native deletion call.

The tool refuses the last scene, recording/count-in, pending launches, frozen target clips and a playing target row. A lagging slot index cannot authorize deleting a natively playing clip. Other rows may continue playing. Resolve a refusal without silently stopping a performance, changing recording setup or removing a different row.

Limits are 256 tracks, 1024 scenes, 16384 Session slots and 16384 stored MIDI notes. Each clip supports 4096 notes or warp markers; reads do not sample or truncate material.

## Read the outcome

Inspect `deleteRequested`, `nativeReturned`, `targetAbsent`, `deletionVerified`, `existingLayoutPreserved`, `remainingMaterialPreserved`, `playbackPreserved`, `readbackPending`, `observed`, `error` and `observationError` independently. A returned native call does not prove deletion. A native exception can leave the target absent; that fact is separate from a verified outcome.

Later callbacks require two matching observations within three attempts without repeating deletion. If the Song becomes unavailable, the result retains dispatch facts and unknown observation fields. Partial removals remain without automatic rollback or replay. After a lost reply, inspect actual scenes and rows before deciding what remains. Do not use global undo as recovery.

Scene and clip-slot IDs below the deleted row shift upward, and Live can move selection. Reload current IDs and selection before subsequent work. Independently compare surviving notes/audio, timing, stop buttons, scene overrides and actual playback.

Source-file bytes and hidden-state backups are not verified. Audio source files and shared track devices are outside scene removal; do not delete files, tracks, instruments or additional rows beyond the named scope. Saving follows its own requested authority.
