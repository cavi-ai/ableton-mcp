# Crop a MIDI phrase

Use `crop-midi-phrase` through `get_producer_workflow` or its MCP prompt in the `all` profile for requests such as “keep only this loop.” Default `mode: "copy"` creates a named alternative before cropping; `in-place` requires explicit intent to discard content from the existing clip. Retrieving the workflow does not edit Live.

## Preserve the original and resolve the interval

Read complete `get_midi_clip_notes_extended` and `get_clip_timing` for the exact Session or Arrangement MIDI clip. Native crop uses the current loop interval when enabled, otherwise its start/end markers. These limits use absolute source-clip beats. They are different from Arrangement song positions, repeated loop passes, piano-roll time selection and selected note IDs. Confirm that the observed interval matches the requested phrase before proceeding. Setting a different interval is a separate edit.

Create a named Session copy with `duplicate_midi_clip_variations` in an existing empty slot. Arrangement material uses separately scoped duplication or copying into verified nonoverlapping space. Resolve the copy's exact owner and clip IDs afterward, then read its own notes and timing. Missing space does not authorize replacement or deletion. Native copies preserve the original; exposed note JSON does not establish a complete expression or envelope backup.

## Plan and crop

Call `crop_midi_clip` with exact `trackId`, `clipId` and fresh `expectedStateVersion`. Inspect the plan's `before.selectedRegion` and complete exposed source context. The native boundary binds target identity, notes, timing and edit context, rechecks inside undo entry and invokes `Clip.crop()` once. It supports at most 256 tracks, 4096 clips per target collection and 4096 stored notes. Recording, overdubbing, count-in, frozen or unknown state, pending launches and unavailable native crop refuse.

Native crop can retain pre-loop pickup material, shorten notes crossing the end, select the target clip, discard notes/hidden expression/envelopes, shift source coordinates and change note IDs. The preview interval is not a guarantee of exclusive retained-note bounds. It is different from adjusting playback bounds while keeping the underlying material. The [Clip API](https://docs.cycling74.com/apiref/lom/clip/) describes the native loop/marker interval. Do not assume how every note crossing a boundary is treated; inspect actual retained starts and durations. The tool does not remove and reconstruct notes to emulate cropping.

## Inspect and compare

Inspect `writeRequested`, `nativeReturned`, `readbackAvailable`, `targetIdentityPreserved`, `notesChanged`, `timingChanged`, `observed`, `error` and `observationError` separately. `observed` includes complete exposed notes, timing, current interval and edit context. A returned native call or available readback does not prove the desired phrase is correct. Read `get_selection_context` after cropping to report native focus changes; do not silently navigate back. Independently read notes and timing, compare retained and removed material and bounds, and confirm the original remains unchanged. Resolve new IDs and source coordinates before subsequent edits. Hidden expression and envelopes are not verified.

A native or undo-finalization failure can leave a partial crop. Inspect actual content before planning remaining work; there is no automatic rollback or replay. After a lost reply do not blindly crop again or use global undo. A no-change result is not evidence that hidden contents were unaffected.

Audition only within playback authority. A playing phrase can change when cropped; continued transport does not prove seamless or equivalent audio. Compare the named alternative with the user, keep the original and preferred result, and scope saving, deletion and further edits separately.
