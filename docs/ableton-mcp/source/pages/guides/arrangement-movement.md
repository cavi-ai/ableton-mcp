# Move an Arrangement part

Use `move-arrangement-part` to move one placed MIDI or audio clip on its current ordinary track. Supply the musical intent and destination, with `collaborative` or `autonomous` mode. The workflow resolves the source, locators, current recording context and the intended quarter-note song position before planning `move_arrangement_clip`. A whole section, ripple edit or move across tracks requires a different scope.

## Review the destination

Read `list_arrangement_clips` and the source's complete notes or audio settings and `get_clip_timing`. Supply its exact clip ID, `startBeats` and fresh `expectedStateVersion`. Self-overlap is supported; overlap with another clip refuses. Current meter does not establish a historical bar map across meter changes. Resolve ambiguous source clips or musical positions before confirming.

The updated Remote Script binds the native source, its exposed content and prior timeline layout. Manual source edits or replacement require a fresh plan even without a bridge version change. Frozen or Group tracks, recording and count-in refuse. A real move requires at most 4095 clips so a temporary copy fits within the 4096-clip readback limit; source notes are limited to 4096 without sampling. An unchanged destination skips writes and undo.

## Confirm and inspect

Review `stagingStartBeats` and `stagingEndBeats` as well as the destination. Staging is placed after both existing material and the planned destination. Within one undo step, the bridge verifies staged notes or audio settings and timing before deleting the original, then verifies the destination before removing staging.

Confirm once and inspect `moveVerified`, the requested/returned step flags, `sourceRetained`, `stagingClip`, `movedClip`, `observedDestination` and `existingIntervalsPreserved`. Re-read the returned destination ID, interval and notes or audio settings independently; copying can renumber clip and note IDs. The tool does not start or stop transport; moving material can change what plays. Audition separately when requested, using `audition_arrangement_passage` and a separately scoped transport_stop.

On any failure, execution stops and retains partial material. The original may already be removed while staging remains. A native call that creates material and then raises can leave an unidentified extra clip; inspect the complete returned inventory before recovery. Unknown source ownership is reported as `sourceRetained: null` with `observationError`. Do not replay confirmation, reconstruct the source or automatically delete partial work. Additional destructive recovery needs an explicit choice about the observed material.

Verification covers exposed note properties, timing, audio settings, and prior native clip identities, names, types and intervals. Other clips' hidden contents, clip-envelope contents or retargeting, external sample bytes and audible equivalence are outside verification. Audio copies share their source file; clips on the track share processing.
