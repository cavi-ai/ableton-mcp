# Import MIDI files

Use `import-midi-file` through `get_producer_workflow` to import a chosen native browser item and inspect the resulting parts. Search the actual browser and pass its exact returned root/path to `load_browser_item`. A filesystem path is not a browser path. Files outside indexed locations need another supported import route.

Live can import several standard MIDI formats, including multitrack files; see [Ableton’s MIDI file guidance](https://help.ableton.com/hc/en-us/articles/209068169-Understanding-MIDI-files). Native browser loading can create separate tracks rather than put a clip on the selected track. Resolve whether new imported parts or replacement is intended before loading. Preserve populated tracks and use an authorized empty compatible MIDI track as an anchor. Creating the anchor is a separate change.

## Plan and inspect

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
