# Define MIDI phrase bounds

Use `set-midi-phrase-bounds` through `get_producer_workflow` or its MCP prompt in the `all` profile for requests such as “start this phrase after the pickup” or “try a shorter ending.” Default `mode: "copy"` makes a named alternative; `in-place` requires explicit intent to edit the existing clip's markers. Retrieving the workflow does not edit Live.

This marker tool supports loop-enabled clips only. Read complete `get_midi_clip_notes_extended` and `get_clip_timing` for the exact Session or Arrangement MIDI clip. Start/end markers use absolute source-clip quarter-note beats. They differ from Arrangement song positions, offsets from the loop start and repeated loop passes. A highlighted slot, selected notes or editor time selection do not establish the intended interval.

## Markers and loops

Markers change playback bounds while keeping the stored notes, including notes outside the active region. They do not move, shorten, remove or rebuild notes. They are different from destructive cropping.

Loop settings remain unchanged. A looped clip continues repeating its existing loop range; changing markers alone does not define a new loop. A pickup start can precede that loop. Playing a finite phrase once or changing its repeating range uses separately scoped `set_clip_timing`; those edits can change stored loop bounds. Do not toggle looping to bypass the marker support limit. Nonlooped marker edits refuse before writing because native marker setters can return without applying the requested values. See the [Clip API](https://docs.cycling74.com/apiref/lom/clip/) for native marker and loop properties.

## Plan an alternative

Create a named Session copy with `duplicate_midi_clip_variations` in an existing empty slot. Arrangement sources use separately scoped duplication or copying into verified nonoverlapping space. Resolve the new clip/owner IDs and read the copy's own notes and timing. Missing space does not authorize overwriting or removing content. Preserving an original through a native copy does not establish a complete hidden-expression or envelope backup.

Call `set_midi_clip_markers` with exact `trackId`, `clipId`, fresh `expectedStateVersion` and at least one `startBeats` or `endBeats`. An omitted bound retains its observed value; the final nonnegative range must be increasing. The updated bridge binds native identity, complete exposed notes, timing and edit context. It supports at most 256 tracks, 4096 clips per target collection and 4096 stored notes. Recording, overdubbing, count-in, frozen or unknown states, pending launches and unavailable markers refuse.

Native execution uses one undo step and valid intermediate ordering, rechecking before each changed setter. Same-value edits make no native write or undo step. A manual change between setters stops further writes without reverting the user's work. A native setter can also change a field before raising; inspect partial results rather than assuming nothing happened.

## Inspect and listen

Inspect `writeRequested`, `nativeReturned`, `attemptedFields`, `completedFields`, `markersVerified`, `targetIdentityPreserved`, `notesPreserved`, `loopPreserved`, `unrequestedTimingPreserved`, `error`, `observationError` and `observed` separately. `completedFields` means setters returned, not independently verified values. Read complete notes and timing afterward to compare requested markers, unchanged IDs/properties, the original loop and unrelated timing. Readback of issued marker setters tolerates differences within 0.0000002 beats. Omitted bounds and no-op markers must remain exact. Hidden expression and envelopes are not verified.

Partial writes remain for inspection without automatic rollback or replay. After a lost reply read actual markers before planning further edits; do not use global undo. Audition only within playback authority and consider Session overrides for Arrangement material. A playing phrase can change, and transport continuation does not prove seamless or equivalent audio. Compare the named alternative with the user, preserve the original and preferred result, and scope saving, deletion and destructive cropping separately.
