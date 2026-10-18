# Edit the selected MIDI notes

Use `edit-selected-midi-notes` through `get_producer_workflow` or its MCP prompt for requests such as “make these notes quieter” or “shorten the selected hits.” The `all` profile provides `get_midi_note_selection`; `set_midi_note_properties` accepts its optional `expectedNoteSelectionToken`.

## Read the actual selection

Resolve `get_selection_context.detailClip`, then read `get_midi_note_selection` for that exact `trackId` and `clipId`. Session and Arrangement MIDI clips are supported. The target must be Live's current detail clip; the highlighted Session slot can refer to different material. The read does not move focus, select notes or modify content.

`status: "selected"` returns ordered `noteIds`, complete exposed selected-note properties and `selectionToken`. `empty` returns empty arrays; it never means all notes. `unavailable` means the native selected-note read is unsupported, while `not_detail_clip` means another clip is current. Both return null note arrays and token. A changing selection or more than 4096 selected notes refuses the read without sampling. This is native clip selection, not screenshot evidence of the foreground piano roll. See the [Live Clip API](https://docs.cycling74.com/apiref/lom/clip/) for native note-selection methods.

## Bind a property edit

Plan `set_midi_note_properties` with the requested per-note `changes`, fresh `expectedStateVersion` and `expectedNoteSelectionToken` set to the observed token. Changes may affect a subset of those selected IDs. Recording/count-in must be off and the target unfrozen. Preserve unselected notes and all properties outside the requested pitch, timing, velocity, probability or mute changes. Hidden expression data is not exposed or verified by this selection read.

The optional token binds native clip/track identity, current detail clip and exposed selected-note records. Node planning and native execution recheck the token and changed IDs before writing. Selection-only edits can invalidate a plan even at the same bridge state version.

All direct `set_midi_note_properties` requests, including explicit-ID edits without a selection token, bind native target identity, complete exposed notes, clip timing and edit context. The updated bridge supports at most 256 tracks, 4096 clips per target collection and 4096 stored notes. Changes require 1–4096 unique existing note IDs; empty edits and repeated IDs refuse. Recording, overdubbing, count-in, frozen or unknown state, pending launches and unavailable native modification refuse. Resolve these states within the user's scope; never change them to bypass a refusal. Playback may continue. Other MIDI transformation tools do not acquire these checks automatically.

Native execution rechecks the source inside undo entry and immediately before one batch modification. Only requested properties of changed notes are submitted, retaining native IDs. Same-value changes make no native write or undo step. The operation does not delete/recreate notes or change loop bounds, markers, selection, devices or routing. Hidden expression is not inspected or verified; exposed note JSON is not a full performance backup.

## Inspect and continue

Confirm the unchanged plan, then inspect `writeRequested`, `nativeReturned`, `editVerified`, `targetIdentityPreserved`, `noteIdsPreserved`, `unrequestedNotesPreserved`, `clipTimingPreserved`, `error`, `observationError` and `observed` separately. `notes` retains the requested-note readback when available; `observed` includes complete exposed notes and current context. Independently read complete notes and compare requested fields and preserved unselected material. Readback tolerates native timing/probability differences within 0.0000002; other exposed properties must match. A native setter or undo-finalization failure can leave a partial edit. Inspect actual notes before planning remaining work; there is no automatic rollback or replay.

Re-read selection before further edits: changing selected-note properties can produce a new token. The token is a bounded current-state observation, not a lock or a history of every selection change.

After a lost reply, inspect actual notes before planning remaining work. Do not replay relative changes, substitute all notes, change another clip or use global undo. Creating a copy, auditioning, saving and deleting material follow their own requested scope. Native note state does not prove audible playback or musical improvement.
