# Develop a Session scene

Retrieve `develop-session-scene` through `get_producer_workflow` or its MCP prompt for requests such as “try a sparse version of this verse.” Resolve the exact source from current selection, scenes and `get_scene_launch_context`. Establish which parts should change and preserve the original row.

A scene spans ordinary tracks and Groups, including empty stop buttons, clip launch settings and tempo/meter overrides. Native scene duplication copies Session clips on their existing tracks. It does not create independent instruments, mixer settings or rendered audio.

## Copy the row

Plan `duplicate_session_object` with `targetType: "scene"`, exact `targetId` and fresh `expectedStateVersion`. The updated bridge binds native Song, track, scene, slot and clip identities, complete exposed Session material and playback state. It rechecks inside one undo step before the native duplicate call. Limits are 256 tracks, 1024 scenes, 16384 Session slots and 16384 stored MIDI notes including the new row; each clip supports 4096 notes or warp markers. Resolve recording, count-in, pending launches and frozen source clips without silently changing unrelated setup.

The [Live Song API](https://docs.cycling74.com/apiref/lom/song/) exposes native scene duplication. The inserted row is immediately below the source. Duplication does not launch it. Scene and clip-slot IDs below the insertion shift; read current IDs again before any later action.

Inspect `copyRequested`, `nativeReturned`, `copyVerified`, `copiedMaterialVerified`, `existingLayoutPreserved`, `existingMaterialPreserved`, `playbackPreserved`, `sceneId`, `error` and `observationError` separately. A returned native call is not independent verification. Later callbacks require two matching observations within three readback attempts, without issuing the copy again. Inspect `readbackPending` and the exposed copied row in `observed`; unavailable readback retains insertion facts with unknown material/playback status. Existing objects and material must remain intact; MIDI note IDs can change in the copy while the other exposed note properties match. Audio copies share their source file. Hidden expression, envelopes and source-file bytes are not verified.

Partial insertions remain without automatic rollback, cleanup or replay. After a lost reply, inspect current scenes and rows before planning remaining work. Do not use global undo as recovery.

## Refine and audition

Read the original and copy independently, including complete notes or audio state, timing, stop buttons and scene overrides. Rename the confirmed copy with a fresh `rename_session_object` plan when requested, then refine only the named parts through the appropriate clip workflows. Preserve intervening manual changes. Missing tools or space do not authorize overwriting content.

Track devices, mixer settings, routing and arms are shared across both rows. Use a separately authorized instrument comparison when an independent sound is required.

With playback authority, preview the complete row again using `get_scene_launch_context`. Inspect clips, empty stop buttons, Groups, arm/recording risks and tempo/meter overrides before `launch_scene`, then read actual playback. Ask what the user hears in collaborative work; duplication does not prove audible equivalence. Keep the original and preferred alternative. Saving and deleting rows follow their own requested scope.
