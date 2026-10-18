# Add notes to an existing part

Use `add-notes-to-midi-part` through `get_producer_workflow` or its MCP prompt for a fill, counterline or extra hits. The `all` profile exposes `get_midi_note_insertion_context` and `insert_midi_notes`.

Resolve the exact Session or Arrangement clip and inspect its instrument, notes and musical context first. The insertion context reads complete notes, timing, native identity and edit safety without changing focus. Sources and final clips are limited to 4096 notes; reads never sample a larger part.

Supply explicit `pitch`, `start`, `duration` and `velocity` for each addition. Starts use absolute source-clip beats, including for Arrangement clips. They are not song positions or offsets from the loop start. Optional defaults are `velocityDeviation: 0`, `releaseVelocity: 64`, `probability: 1` and `mute: false`. Loop bounds and markers remain unchanged, so notes outside the audible range may not play and looped material repeats.

The tool refuses same-pitch overlaps with existing notes or other additions. Adjacent events and overlapping different pitches are allowed. Resolve a refused musical conflict without silently removing or shortening the original notes. Recording/count-in, frozen or unknown state, pending launches and unsupported native insertion also refuse. Existing playback can continue.

Review and confirm a fresh plan. Both planning and native execution recheck complete notes, timing and native target identity; the final check occurs immediately before the add request. The path uses native [note insertion](https://docs.cycling74.com/apiref/lom/clip/) without rewriting original notes. Readback checks existing note IDs and exposed values, added IDs/properties and timing. Hidden per-note expression is not exposed or verified.

Inspect `nativeReturned`, `insertionVerified`, `existingNotesPreserved`, `addedNoteIds`, `error` and `observed` separately. A partial native write remains in the clip. After a mismatch or lost reply, read complete notes and reconcile the actual additions before planning remaining events. Do not replay the whole list or rebuild the clip. Auditioning, creating comparison copies and saving follow their own requested scope; stored notes do not prove audible output or musical improvement.
