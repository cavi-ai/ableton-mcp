# Develop an audio clip

To bring in a local recording or loop first, use [audio import](audio-import.md), which distinguishes direct Arrangement import from Session staging and preserves the source file.

Retrieve `develop-selected-audio-clip` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the change to the selected Session audio clip and any timing, pitch or texture to preserve.

## Preserve the source

Resolve `get_selection_context.detailClip`, then inspect its exact track, audio state, timing and available Session slots. The highlighted slot and selected scene can refer to other material. Recording, pending source/destination launches and frozen tracks must be resolved before copying.

Plan `duplicate_clip` with the source `clipId`, an empty `destinationClipId` on the same track, an optional descriptive `name`, and fresh `expectedStateVersion`. Execute its unchanged confirmed plan. The updated bridge binds native document, track, clip and slot identity, rechecks exposed source content, verifies the new copy and attempts cleanup of a failed new copy. It supports at most 4096 MIDI notes or audio warp markers. A changed source or occupied destination needs a fresh plan; never overwrite or blindly retry after a lost reply.

`copyVerified: true` covers exposed timing, name, color, MIDI note properties or audio source reference, gain, pitch, warp mode, warp markers and available fade state. Native duplication handles envelopes; their contents, hidden state and external file bytes are not compared. Audio copies share the source file and are not independent sample backups.

To reuse the clip through another existing audio track's processing, follow [Reuse Session clips](clip-reuse.md). `destinationTrackId` selects that compatible owner; omitting it retains this workflow's same-track behavior. Cross-track envelope retargeting is not verified.

## Refine the copy

Read the copy's own `get_audio_clip_state` and `get_clip_timing` before each change. Use `set_audio_clip_state` for requested pitch, gain, warp mode or playback markers, and `set_clip_timing` for a loop interval. Warped clips use beats; unwarped clips use seconds. Change warping separately and re-read the resulting timing before editing markers or loops. A loop change alone does not trim all playback.

For unwarped audio, `markers.startSeconds/endSeconds` report the active nonlooped range, matching `loop.startSeconds/endSeconds` even when `loop.enabled` is false. Stored warped-marker values are not the active bounds. Omitting a boundary retains the observed active boundary. The packaged bridge edits this range directly without redundant stored-marker writes; inconsistent older-bridge bounds refuse planning and require a bridge reload.

After a marker edit, inspect `verification.markerBoundsConfirmed` and `mismatches`. The server reads native audio state in a separate callback, checks the requested and retained boundaries, units, target IDs and state version, and exposes both `observed` and `immediateObserved`. Ignored or clamped writes and unavailable readback remain explicitly unconfirmed. This check covers playback bounds, not other simultaneous edits, file bytes, envelopes, hidden state or audible output. Inspect partial results before continuing; never blindly replay an uncertain edit. Arrangement edits also need inspection of their actual returned timeline.

The receipt also reports `warpMarkersChanged` and `arrangementContextChanged` against the pre-edit observation. Native Arrangement trims can resize the placed clip and rebase stored warp anchors, including when warping is off. Inspect those exposed changes separately from bounds confirmation; differences do not establish whether the tool or an intervening manual edit caused them. Preserve an original copy before comparison, and inspect its actual mapping and placement before re-enabling warp or continuing arrangement work.

For a requested reversal, follow [Reverse an audio alternative](audio-reversal.md) on the uniquely named copy. Native reversal changes its whole source reference and timing/warp placement; inspect the receipt and observed markers before auditioning.

For transient alignment, inspect existing markers and native source-time conversion before applying reviewed `propose_audio_transient_warp` suggestions. Preserve neighboring anchors and deliberate timing. Re-read every affected property and leave unrelated values and manual edits alone. Source-window analysis does not render Live's warp, clip pitch/gain, envelopes or devices; measurements do not establish what the user heard.

Playback-region changes do not require destructive `crop_audio_clip`. Cropping, whole-performance quantization, tuning, deletion and saving each need their own requested scope.

## Audition and keep

Audition only when requested or already authorized, with recording context checked. A clip launch can start transport, replace Session playback on its track and override Arrangement playback. Preserve arms, routing, monitoring, mute, solo and devices. A muted track is not evidence of audible playback.

Use a scoped stop when intended and observe the clip until a quantized stop takes effect. Keep the original and chosen copy in place; preserve partial results and manual edits after interruption. Further refinements need fresh observations and plans. Report exact clips, changed values, actual playback and any uncertainty about identity or cleanup.
