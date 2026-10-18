# Keep the current Session combination

Retrieve `keep-session-combination` through `get_producer_workflow` or its MCP prompt to keep a Session jam as a named scene. Execution requires the `all` profile and updated bridge. Retrieval does not call Live or execute work.

`capture_session_scene` uses Live's native [Capture and Insert Scene](https://www.ableton.com/en/manual/session-view/#editing-scenes): it copies currently playing Session clips into a new row below the selected scene **and immediately launches that row**. This includes muted playing parts and children hidden inside Groups. Full-row launching can change Arrangement overrides or stop empty tracks. The original clip objects remain, but they need not remain playing. If the request is storage without switching playback or a chosen subset, use [Build a Session scene](session-scene-building.md) with explicit copies instead.

Capture does not render or record audio, copy Arrangement material, collect samples or save the Set. Mixer, mute/solo, device and Return/Main settings do not become scene recall settings. Current performance phase is not a recorded result or a guarantee of later synchronization.

## Review the full native effect

Read selection, scenes, tracks, sources and recording context. Transport must already be playing with at least one playing Session clip. All explicit and implicit track arms must be off because native capture launches the row; recording, count-in, pending launches/stops and frozen playing sources also refuse. Do not silently disarm other tracks or start playback to bypass those conditions.

Resolve an explicit name and `afterSceneId` from the currently selected scene. Another requested anchor requires a separate scoped `show_live_object` call on an exact Session slot in that row (`trackId`, `clipId`, `view: "Session"`), followed by selected-scene readback. Plan `capture_session_scene` with that anchor, the name and fresh `expectedStateVersion`. Review `launchesCapturedScene: true`, every track's playing source and Arrangement override, scene order and insertion position before confirming the unchanged plan. Names must contain 1–128 characters without controls.

The plan binds native track/scene/slot/clip identities and exposed playing-source notes/timing or audio state. It rechecks at undo entry before one native capture call. Clock advancement is excluded; changed sources, replaced objects or another selected scene need a fresh plan. Readiness is checked again before naming and after finalization. Limits leave room for the new row within 256 tracks, 1024 scenes and 16384 Session slots, with at most 4096 notes or warp markers per playing source and 16384 playing-source notes overall.

## Inspect material, markers and playback separately

Read `captureRequested`, `nativeReturned`, `nameWriteReturned`, `captureVerified`, `existingLayoutPreserved`, `sourcePreserved`, `originalPlaybackRetained`, `capturedPlaybackVerified`, `playback`, `sceneId`, `scene`, `sources`, `rows` and errors independently.

`captureVerified` covers the named row's exposed clip material, retained original source content and existing scene/slot layout. Live can change copied start markers while capturing the current combination. Each row reports `materialMatched` with start-marker positions excluded, exact `contentMatched`, `startMarkerMatched`, and source/captured `startMarkers`. Other exposed timing, note and audio fields remain compared. New MIDI note IDs can differ. Read and discuss actual marker differences; do not silently reset them or claim exact source timing or audible phase equivalence.

`originalPlaybackRetained` describes the old playing references; native capture normally switches playback to the captured copies. `capturedPlaybackVerified` separately observes whether all captured nonempty slots are currently playing. A false immediate playback observation needs fresh clip/transport readback, not another capture or blind launch. Neither field proves speaker output, an unchanged mix or musical quality.

Partial work remains without rollback, deletion or replay. A native exception or lost reply can leave a launched scene with unconfirmed ownership. Inspect current scenes, row contents, playback and recording before continuing. A matching name alone does not establish provenance.

Insertion shifts IDs. Refresh lists and use `sources.currentClipId` to resolve original source objects. Native selection can change. Read the actual new row through `get_scene_launch_context`, including empty stop buttons, launch settings, tempo/meter overrides, Groups and recording consequences. Keep transport running unless a stop was requested. Later launches, marker edits, refinements, cleanup and Set saving retain their own scope and fresh plans.

Audio copies share source files; source bytes, envelope contents/retargeting, hidden state and audible equivalence are not compared. Use separately requested [audio capture](live-audio-capture.md) for a recording of current output. Discuss what the user hears and preserve their manual changes.
