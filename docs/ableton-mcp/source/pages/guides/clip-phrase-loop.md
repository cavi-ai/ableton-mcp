# Repeat a phrase or play it once

Use `set-clip-phrase-loop` through `get_producer_workflow` or its MCP prompt for requests such as “repeat these two bars” or “try this phrase once.” The default `copy` mode preserves the original through a named alternative; `in-place` requires intent to edit the existing clip. Retrieving the workflow does not edit Live.

Resolve one exact Session or Arrangement clip. Read `get_clip_timing`, complete MIDI notes or `get_audio_clip_state`, musical context and recording state. MIDI and warped audio loop limits use absolute source-clip quarter-note beats; unwarped audio uses source seconds. Arrangement song positions, offsets from loop start and repeated passes are different coordinates.

## Change the loop controls

Create a compatible named Session copy in an existing empty slot, or separately scoped Arrangement copy in verified nonoverlapping space. Resolve the copy's own IDs and current material. Missing space does not authorize overwriting content. Exposed reads do not establish a complete hidden-expression, envelope or plug-in backup.

Plan `set_clip_timing` with exact `trackId`, `clipId`, fresh `expectedStateVersion` and the intended `loop` fields. Set `enabled` for repeating or one-shot behavior and use the matching `startBeats`/`endBeats` or `startSeconds`/`endSeconds`. Omitted loop fields retain their observed values; mode-change plans include both final bounds and switch mode before applying them. The final interval must be increasing and nonnegative. Unwarped audio cannot repeat; do not enable warping implicitly.

The [Live Clip API](https://docs.cycling74.com/apiref/lom/clip/) defines loop positions as playback start/end when looping is disabled. Native loop controls can therefore change playback markers. Requested loop settings and actual playback markers are separate evidence. Inspect both before claiming a finite phrase starts or ends at a specific position. These edits do not crop or rebuild stored notes or rewrite the source file.

The updated bridge binds the exact native clip and owners, complete exposed MIDI notes or audio source/processing state, all timing and recording/frozen/pending-launch flags. Limits are 256 tracks including Groups, 4096 clips in the target collection, 4096 stored MIDI notes or 4096 audio warp markers. Resolve unsafe or unknown states without silently stopping playback, unfreezing material or changing unrelated recording setup. Every changed setter rechecks the source inside one undo step. Same values make no native write or undo entry. Mixed timing requests remain supported.

For nonlooped Arrangement clips, these controls can resize the occurrence's right edge. The plan binds all clips on that track and checks every intermediate extent, including mode changes and setter ordering, before confirmation and again at the native boundary. Beat-based overlap refuses. Unwarped expansion with following clips needs a separately resolved empty destination because source seconds do not establish the required song-beat span across a tempo map. Do not silently relocate material or enable warping to bypass that limit.

## Read the result and listen

Inspect `writeRequested`, `nativeReturned`, `attemptedFields`, `completedFields`, `requestedChangesVerified`, `targetIdentityPreserved`, `notesPreserved`, `audioSourcePreserved`, `audioSourceIdentityPreserved`, `warpMarkersPreserved`, `warpMarkersRebased`, `readbackPending`, `markersChanged`, `arrangementSpanChanged`, `unrequestedTimingPreserved`, `observedContext`, `error` and `observationError` independently. The result retains the usual timing fields when readback is available. Completed fields mean setters returned, not verified success. `nativeReturned` means the needed setter phase finished; native coupling can make a redundant setter unnecessary. Issued numeric loop setters allow native rounding within 0.0000002 units; omitted and no-op fields remain exact.

Readback uses later native callbacks and requires two matching observations, within three callbacks, without replaying setters. An unavailable Song retains attempted/completed setter facts with unknown preservation fields. Inspect pending or failed verification before continuing.

For unwarped audio, changing the active start can translate inactive warp-marker sample times uniformly while preserving their beat positions. `warpMarkersRebased` reports this recognized native effect; `audioSourcePreserved` and `warpMarkersPreserved` remain false when their exposed data changed. Source identity is separate from source-file byte verification.

Read complete material and timing again. Compare loop settings, actual markers, unchanged MIDI IDs/properties or exposed audio state and unrelated timing. Native marker coupling or Arrangement resizing can make `unrequestedTimingPreserved` false even when the requested loop fields were applied. Hidden expression and source-file bytes are not verified.

Partial edits remain for inspection without automatic rollback or replay. After a lost reply, read actual state before planning only remaining intended work. Do not use global undo as recovery. Audition within playback authority, consider Session overrides for Arrangement clips, and compare the alternative with the user. Continued transport is not proof of seamless or equivalent audio. Keep the original and preferred copy; saving and deleting copies follow their own requested scope.
