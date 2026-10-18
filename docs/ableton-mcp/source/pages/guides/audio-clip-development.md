# Develop an audio clip

Retrieve `develop-selected-audio-clip` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the change to the selected Session audio clip and any timing, pitch or texture to preserve.

## Preserve the source

Resolve `get_selection_context.detailClip`, then inspect its exact track, audio state, timing and available Session slots. The highlighted slot and selected scene can refer to other material. Recording, pending source/destination launches and frozen tracks must be resolved before copying.

Plan `duplicate_clip` with the source `clipId`, an empty `destinationClipId` on the same track, an optional descriptive `name`, and fresh `expectedStateVersion`. Execute its unchanged confirmed plan. The updated bridge binds native document, track, clip and slot identity, rechecks exposed source content, verifies the new copy and attempts cleanup of a failed new copy. It supports at most 4096 MIDI notes or audio warp markers. A changed source or occupied destination needs a fresh plan; never overwrite or blindly retry after a lost reply.

`copyVerified: true` covers exposed timing, name, color, MIDI note properties or audio source reference, gain, pitch, warp mode, warp markers and available fade state. Native duplication handles envelopes; their contents, hidden state and external file bytes are not compared. Audio copies share the source file and are not independent sample backups.

To reuse the clip through another existing audio track's processing, follow [Reuse Session clips](clip-reuse.md). `destinationTrackId` selects that compatible owner; omitting it retains this workflow's same-track behavior. Cross-track envelope retargeting is not verified.

## Refine the copy

Read the copy's own `get_audio_clip_state` and `get_clip_timing` before each change. Use `set_audio_clip_state` for requested pitch, gain, warp mode or playback markers, and `set_clip_timing` for a loop interval. Warped clips use beats; unwarped clips use seconds. Change warping separately and re-read the resulting timing before editing markers or loops. A loop change alone does not trim all playback.

For a requested reversal, follow [Reverse an audio alternative](audio-reversal.md) on the uniquely named copy. Native reversal changes its whole source reference and timing/warp placement; inspect the receipt and observed markers before auditioning.

For transient alignment, inspect existing markers and native source-time conversion before applying reviewed `propose_audio_transient_warp` suggestions. Preserve neighboring anchors and deliberate timing. Re-read every affected property and leave unrelated values and manual edits alone. Source-window analysis does not render Live's warp, clip pitch/gain, envelopes or devices; measurements do not establish what the user heard.

Playback-region changes do not require destructive `crop_audio_clip`. Cropping, whole-performance quantization, tuning, deletion and saving each need their own requested scope.

## Audition and keep

Audition only when requested or already authorized, with recording context checked. A clip launch can start transport, replace Session playback on its track and override Arrangement playback. Preserve arms, routing, monitoring, mute, solo and devices. A muted track is not evidence of audible playback.

Use a scoped stop when intended and observe the clip until a quantized stop takes effect. Keep the original and chosen copy in place; preserve partial results and manual edits after interruption. Further refinements need fresh observations and plans. Report exact clips, changed values, actual playback and any uncertainty about identity or cleanup.
