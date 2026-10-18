# Reuse a part on another track

Retrieve `reuse-session-clip` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. For example, ask “copy these chords to the existing piano track, keep the original, and leave playback stopped.” The workflow resolves the source, destination and empty Session slot before planning a native copy.

For timeline material, use `reuse-arrangement-clip` with the source passage, intended destination and musical purpose. Collaborative mode resolves the direction with the user; autonomous mode chooses within the brief. Playback, instrument replacement, saving and deletion remain separately scoped.

## Reuse an Arrangement passage

Resolve an exact current `track-N:arrangement-clip-M` through `list_arrangement_clips`, read its notes or audio state and timing, and inspect the destination's devices, mixer and routing. `copy_arrangement_clip_to_track` copies one whole observed timeline span to a different compatible ordinary track. Supply `trackId`, `clipId`, `destinationTrackId`, explicit `startBeats`, `name` and fresh `expectedStateVersion`. The complete destination interval must be empty. The name must be nonempty, at most 128 characters and contain no control characters.

The plan binds native source/destination owners and clip layouts, the source interval, complete stored MIDI notes/timing or exposed audio settings. It rechecks at undo entry. Recording/count-in, frozen tracks, incompatible types and stale contexts refuse. Lookup is bounded to 256 tracks, 4096 source clips and room for one copy within 4096 destination clips; content reads support 4096 MIDI notes or warp markers. Devices, mixer and routing remain on their tracks. This does not duplicate the whole track or convert the passage to Session.

Inspect `copyRequested`, `nativeReturned`, `nameWriteReturned`, `copyVerified`, `sourcePreserved`, `destinationRetained`, `copiedClipId`, `copiedClip`, `observedCopy`, `destinationClips` and errors independently. Partial work remains without rollback or replay. A native exception or lost reply may leave a copy with unconfirmed ownership; inspect the current destination before any further action. Never delete an ambiguous candidate or globally undo over manual work.

Read the actual copy's notes/settings and requested interval/name again. New MIDI note IDs can differ. Copy verification excludes the adaptive editor grid. Audio shares its source file; file bytes, envelope contents/retargeting, hidden expression and plug-in state are not verified. A copy does not establish audible equivalence. Authorized listening follows [Arrangement audition](arrangement-audition.md); keep existing material and processing intact.

## Choose a Session destination

Read `list_clips` on both exact tracks. MIDI clips need an ordinary MIDI destination and audio clips an ordinary audio destination. The destination slot must already exist and be empty. Track or clip names can repeat; resolve their IDs instead of guessing. Creating space, loading an instrument, converting audio/MIDI, changing routing or overwriting existing content requires a separate scope.

MIDI uses the destination's existing instrument and processing. A copied phrase does not copy the source instrument sound or establish audible output. Audio copies share their source file and use destination processing; they are not rendered stems or independent sample backups. Envelope contents and cross-track retargeting are not verified. Do not assume an equivalent control exists on another track.

## Plan, copy and inspect

Use `duplicate_clip` with source `trackId`/`clipId`, `destinationTrackId`, `destinationClipId`, optional `name` and fresh `expectedStateVersion`. Omit `destinationTrackId` for a copy on the same track. Both tracks must be unfrozen, global recording off, the source not recording and source/destination launches resolved. The updated bridge binds native track/slot/clip identities, destination type and names, plus exposed source notes/timing or audio state. It supports at most 4096 stored notes or warp markers. Changed sources, replaced tracks/slots and occupied destinations invalidate the plan.

Confirm the unchanged plan. Require `copyVerified`, the expected `sourceTrackId`, `sourceClipId` and `copiedClipId`. The returned `trackId` and `clips` list belong to the destination. Independently read the copy's full MIDI properties and timing or audio state, then check the source and destination processing baselines. Note IDs may change. Copy verification excludes envelope contents, hidden state and external file bytes.

Copies use one native undo step. Failed verification attempts to remove only the newly confirmed copy. If native copying throws before its new clip can be identified, or ownership changes, cleanup is skipped and partial state is reported. A lost reply needs inspection of both exact slots before retrying; never delete uncertain content or replay the copy blindly.

## Listen and continue

Audition only when requested or already authorized. Launching the copy can start transport, replace destination Session playback and override Arrangement playback; unrelated tracks can sound. Preserve arms, monitoring, mutes, solos, routing and devices. A muted destination and a successful copy receipt do not prove an audible result. Keep the original and chosen copy. Further musical edits, sound changes, deletion and saving have their own scope.
