# Edit the selected MIDI notes

Use `edit-selected-midi-notes` through `get_producer_workflow` or its MCP prompt for requests such as “make these notes quieter” or “shorten the selected hits.” The `all` profile provides `get_midi_note_selection`; `set_midi_note_properties` accepts its optional `expectedNoteSelectionToken`.

## Read the actual selection

Resolve `get_selection_context.detailClip`, then read `get_midi_note_selection` for that exact `trackId` and `clipId`. Session and Arrangement MIDI clips are supported. The target must be Live's current detail clip; the highlighted Session slot can refer to different material. The read does not move focus, select notes or modify content.

`status: "selected"` returns ordered `noteIds`, complete exposed selected-note properties and `selectionToken`. `empty` returns empty arrays; it never means all notes. `unavailable` means the native selected-note read is unsupported, while `not_detail_clip` means another clip is current. Both return null note arrays and token. A changing selection or more than 4096 selected notes refuses the read without sampling. This is native clip selection, not screenshot evidence of the foreground piano roll. See the [Live Clip API](https://docs.cycling74.com/apiref/lom/clip/) for native note-selection methods.

## Bind a property edit

Plan `set_midi_note_properties` with the requested per-note `changes`, fresh `expectedStateVersion` and `expectedNoteSelectionToken` set to the observed token. Changes may affect a subset of those selected IDs. Recording/count-in must be off and the target unfrozen. Preserve unselected notes and all properties outside the requested pitch, timing, velocity, probability or mute changes. Hidden expression data is not exposed or verified by this selection read.

The optional token binds native clip/track identity, current detail clip and exposed selected-note records. Node planning and native execution recheck the token and changed IDs before writing. Selection-only edits can invalidate a plan even at the same bridge state version. The existing complete-note, timing and prior-property checks still apply. Existing explicit-ID requests without the token keep their earlier behavior; other MIDI transformation tools do not acquire this guard automatically.

## Inspect and continue

Confirm the unchanged plan, then independently read complete notes and compare requested fields and preserved unselected material. Re-read selection before further edits: changing selected-note properties can produce a new token. The token is a bounded current-state observation, not a lock or a history of every selection change.

After a lost reply, inspect actual notes before planning remaining work. Do not replay relative changes, substitute all notes, change another clip or use global undo. Creating a copy, auditioning, saving and deleting material follow their own requested scope. Native note state does not prove audible playback or musical improvement.
