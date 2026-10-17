# Import MIDI files

Use `import-midi-file` through `get_producer_workflow` to import a chosen local file or native browser item and inspect the resulting parts. An explicit local path can use `import_midi_file` without browser indexing on macOS English Live. Browser items use `load_browser_item` with an exact observed root/path. Filesystem and browser paths are different.

Live can import several standard MIDI formats, including multitrack files; see [Ableton’s MIDI file guidance](https://help.ableton.com/hc/en-us/articles/209068169-Understanding-MIDI-files). Native browser loading can create separate tracks rather than put a clip on the selected track. Resolve whether new imported parts or replacement is intended before loading. Preserve populated tracks and use an authorized empty compatible MIDI track as an anchor. Creating the anchor is a separate change.

## Import a local file

Create an authorized empty staging track at the end of the Set with `create_track`. It must be an ungrouped ordinary MIDI track with no devices, Session clips or Arrangement clips, muted, unarmed, unsoloed, unfrozen, monitoring off and No Output. These separate preparation changes remain after failure. Choose an existing Session slot; the tool selects it after confirmation. It never replaces populated material. For Arrangement reuse, import into Session first, then use guarded `place_session_clip_in_arrangement` within the intended timing and scope.

Plan `import_midi_file` with `sourcePath`, staging `trackId`/`clipId`, fresh `expectedStateVersion` and `expectedSetFingerprint`. Require stopped playback/recording and no pending launches. Sources must be regular `.mid`/`.smf` files up to 8 MiB with at most 256 declared tracks. Symlinks are refused. Plans include file identity, full SHA-256 and an SMF header check; Live validates the events. Existing device structure is bounded to 4096 devices per track and 16 nested racks.

Confirmation shows the Session destination, opens native **Create > Import MIDI File**, selects the exact source URL and rechecks the file and native target before Open. It changes selection/focus and does not save the Set. Multitrack import can fill the staging slot and create additional tracks/scenes with Live defaults. Inspect their arms, monitoring, devices and routing before playback. The source checks do not establish an atomic read of file bytes by Live.

`importVerified:true` requires a known Open request, closed owned picker, an observed MIDI clip in the chosen slot, unchanged source-file checks, preserved existing track/device/clip object structure, unchanged tempo/meter and stopped recording/playback. Inspect `observed.targetClips` and `trackEffect` for actual current IDs. Object preservation does not compare existing note, parameter or envelope contents. Full file-event, controller, tempo-map, MPE and audible equivalence remain separate checks; `completePerformanceEquivalenceVerified` and `audibleEquivalenceVerified` remain false.

Unknown Open outcomes are never replayed, undone or deleted. Before Open, cleanup can cancel only the unchanged owned file picker. Changed user input, unexpected dialogs and partial imports require inspection before more input.

## Load a browser item

Pass the exact anchor `trackId`, browser `root` and `path`, and fresh `expectedStateVersion`. Planning is read-only. Review the existing device chain, Session occupancy and `beforeLoadContext`, which binds native objects, browser metadata, Set track/scene topology and view. It does not bind external file bytes or hidden state. The load may change devices, clips, tracks, scenes and the displayed view.

After confirmation inspect these fields:

- `nativeLoadReturned` and `loadError`: whether the native call returned successfully, including an error after partial changes. Neither proves content equivalence or eventual completion.
- `requestedTrackId` and `trackId`: the original anchor ID and its current ID after insertions. A removed target has no current ID; target inspection is unavailable.
- `deviceChainEffect`, `clipEffect` and `targetInspectionError`: immediate changes on the surviving anchor.
- `trackEffect`: actual added tracks, removed track IDs, old-to-current `survivingTracks`, order preservation and scene changes. Added tracks include occupied `sessionClips` and `arrangementClips` with their actual current IDs.
- `addedTracksInspected`, per-track `clipsInspected` and inspection errors: inventories over 256 added tracks or 2048 clip entries per added track are incomplete.
- `selectedTrackRestored`: selected-track restoration only. It does not restore the scene, displayed clip, view or keyboard focus.

Track effects compare native object identities, so identical names do not collapse separate parts. They are immediate observations, not attribution of concurrent user changes. Re-read current tracks, scenes and clip lists before subsequent edits; indices can change again. A browser URI or filename does not establish source-file identity or byte equivalence.

Read the actual imported MIDI notes and clip timing. Compare to an authoritative source only when available. Controller, channel, tempo-map, MPE and audible equivalence require separate checks. MIDI does not include its intended instruments.

After an error or lost reply, inspect the Set and native dialogs before further input. Preserve partial imports and manual edits. Never replay an uncertain load, delete unidentified tracks or use global undo automatically. Adding instruments, moving parts, auditioning, routing and saving the Set require their own scope.
