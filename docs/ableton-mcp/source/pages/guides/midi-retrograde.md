# Reverse a MIDI phrase

Retrieve `reverse-midi-phrase` through `get_producer_workflow` or its MCP prompt in the `all` profile. Describe the phrase and beat window. The default `mode: "copy"` preserves the original through a named alternative; `in-place` requires explicit intent to edit the existing clip. Retrieving the workflow does not change Live.

Read the source's complete notes and timing. Copy Session MIDI with `duplicate_midi_clip_variations` into an existing empty slot. For Arrangement sources, duplicate or copy into explicitly scoped, nonoverlapping timeline space and resolve the new native clip IDs afterward. Read the copy's own note IDs; they need not match the source. Missing space does not authorize replacement, deletion or silently switching to in-place editing.

## Choose the window and notes

Call `transform_midi_notes` with exact `trackId`, `clipId`, explicit unique `noteIds`, fresh `expectedStateVersion` and:

```json
{"type":"reverseTime","startBeats":2,"endBeats":6}
```

This is the tool's `operation` object. Both limits use absolute source-clip quarter-note beats, not Arrangement song time or offsets from the current loop start. The increasing window can be at most 1024 beats wide. All selected whole note spans must fit inside it; crossing notes refuse instead of being trimmed. An empty note list never means all notes. Resolve actual note selection separately when intended; this operation binds exact IDs and exposed note state, not a piano-roll selection token.

A note's new start is `startBeats + (endBeats - (oldStart + duration))`. For example, a half-beat note at beat 2 in the 2–6 window moves to 5.5; a one-beat note at 3 moves to 4. Durations remain unchanged. The complete spans and gaps reflect, rather than only sorting note onsets backward. Unselected notes remain where they were. Existing chords and overlaps can remain; any new same-pitch overlap refuses. Nothing resizes the clip or changes loop and marker bounds. Material outside active markers can remain inaudible or repeat through loops.

## Confirm and inspect

The updated bridge supports Session and Arrangement MIDI, at most 256 tracks, 4096 clips per target collection and 4096 stored notes. It binds native target identity, complete exposed notes, timing and edit context, rechecks immediately before one native batch modification, and retains note IDs without deletion/recreation. Recording/count-in, frozen or unknown states, pending launches and unsupported native modification refuse. Playback can continue. A symmetric no-op makes no write or undo step. Native note modification is described in the [Clip API](https://docs.cycling74.com/apiref/lom/clip/).

Inspect `writeRequested`, `nativeReturned`, `reversalVerified`, `targetIdentityPreserved`, `noteIdsPreserved`, `unrequestedNotesPreserved`, `clipTimingPreserved`, `observed`, `error` and `observationError` separately. Read complete notes and timing afterward to compare the requested starts, retained durations and all other exposed fields. Readback tolerates native timing differences within 0.0000002 beats. A failed setter or undo finalization can leave a partial reversal; inspect actual notes before planning remaining work. There is no automatic rollback, reconstruction or replay. Repeating a reversal after a lost reply can reverse the result back.

Hidden per-note expression and clip envelopes are not reversed or verified. An expression curve may retain its direction inside a moved note, while an envelope can stay at its existing clip position. Exposed note JSON is not a complete performance backup. Stable notes do not establish equivalent expression, audible output or musical improvement.

## Compare with the user

Audition only when requested or already authorized. Launching a Session alternative can replace the track's playing clip or start transport. Arrangement listening follows [passage audition](arrangement-audition.md), considering Session overrides and unrelated sounding tracks. Keep the original and preferred alternative, ask what the user hears, and refresh current notes before further edits. Deleting copies and saving follow their own scope.
