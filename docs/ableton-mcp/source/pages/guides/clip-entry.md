# Compare a Session clip's entry

Retrieve `compare-clip-entry` through `get_producer_workflow`, or open its MCP prompt. For example: “try the phrase starting on its second beat, keep the original, and let me compare.” The default `collaborative` mode resolves musical choices with the user; `autonomous` chooses only within the brief.

## Entry and loop are different

For MIDI and warped audio, the native [start marker](https://docs.cycling74.com/apiref/lom/clip/) sets the initial Session launch entry independently of the repeating loop. It can begin before the loop or partway through it. Unwarped audio cannot loop: its active entry is the native nonlooped range start, in seconds. Changing entry does not move notes, crop audio or establish that a sustained note will retrigger. Legato can use a previous clip's phase instead of this entry, so inspect launch settings before listening.

Resolve the exact Session clip and read `get_clip_timing`. MIDI and warped audio use absolute clip beats. For unwarped audio, use `loop.startSeconds/endSeconds` as the active nonlooped interval, even though `loop.enabled` is false; stored warp-marker bounds are not its active end. The dry-run plan's `before.unit/start/end` bind the chosen native entry and `entryProperty` identifies its native control. Clip-relative bars need the actual clip meter and origin. Do not use global song bars as clip positions or reuse a value after changing warp units.

## Keep an alternative

Duplicate the source with `duplicate_clip` into one existing empty compatible Session slot, giving the copy a clear name. Inspect the verified copy and its own notes or exposed audio state. Keep the original. Audio copies share their source file and do not constitute a separate sample backup. Arrangement placements need a separate editing scope; this operation changes Session launch entry only.

Plan `set_session_clip_entry` with the exact copy, `unit`, `start` and fresh `expectedStateVersion`. The start must be finite and strictly before the retained end marker; seconds must be nonnegative. The updated bridge binds native document/track/slot/clip identities, prior markers, complete exposed content and controls. It supports up to 256 tracks, 4096 MIDI notes or warp markers, and 64 cached target identities; eviction requires a fresh plan.

The target must be inactive, unarmed and unfrozen, with recording/count-in off and no pending launches. Unrelated playback may continue. Unknown controls refuse. Do not stop or disarm unrelated work to force an edit. An older bridge refuses the context read before confirmation; reload the packaged bridge first.

Confirm the unchanged plan once. Execution rechecks at undo entry, skips a no-op property write and reports `writeRequested`, `nativeReturned`, `verified`, `targetRetained`, `retainedStateVerified`, observed state and errors separately. It compares retained notes or exposed audio settings and timing, including the end and repeating loop. For unwarped audio, the nonlooped range start changes with the requested entry; its end and disabled looping remain. It does not compare file bytes, envelopes or hidden state. Partial writes remain for inspection without rollback or replay.

## Listen and choose

Independently read the copy's marker and retained material. Audition only when requested or already authorized, with a resolved launch quantization and prior playback context. Launching can start transport and replace this track's Session or Arrangement playback. Keep mixer, monitoring, routing and arms unchanged. Observe actual playback; a launch request or stored marker does not prove what the user heard or that the result sounds better.

Keep the chosen copy and original. A further edit or baseline-marker restore requires fresh context, matching native `identityToken`, the last applied entry and retained material. Preserve manual edits or uncertain replacement identities. Restoring the marker does not restore playback phase or subsequent content edits. Deletion, broader timing edits and saving remain separately scoped.
