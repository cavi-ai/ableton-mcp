# Reuse a Session part on another track

Retrieve `reuse-session-clip` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. For example, ask “copy these chords to the existing piano track, keep the original, and leave playback stopped.” The workflow resolves the source, destination and empty Session slot before planning a native copy.

## Choose the destination

Read `list_clips` on both exact tracks. MIDI clips need an ordinary MIDI destination and audio clips an ordinary audio destination. The destination slot must already exist and be empty. Track or clip names can repeat; resolve their IDs instead of guessing. Creating space, loading an instrument, converting audio/MIDI, changing routing or overwriting existing content requires a separate scope.

MIDI uses the destination's existing instrument and processing. A copied phrase does not copy the source instrument sound or establish audible output. Audio copies share their source file and use destination processing; they are not rendered stems or independent sample backups. Envelope contents and cross-track retargeting are not verified. Do not assume an equivalent control exists on another track.

## Plan, copy and inspect

Use `duplicate_clip` with source `trackId`/`clipId`, `destinationTrackId`, `destinationClipId`, optional `name` and fresh `expectedStateVersion`. Omit `destinationTrackId` for a copy on the same track. Both tracks must be unfrozen, global recording off, the source not recording and source/destination launches resolved. The updated bridge binds native track/slot/clip identities, destination type and names, plus exposed source notes/timing or audio state. It supports at most 4096 stored notes or warp markers. Changed sources, replaced tracks/slots and occupied destinations invalidate the plan.

Confirm the unchanged plan. Require `copyVerified`, the expected `sourceTrackId`, `sourceClipId` and `copiedClipId`. The returned `trackId` and `clips` list belong to the destination. Independently read the copy's full MIDI properties and timing or audio state, then check the source and destination processing baselines. Note IDs may change. Copy verification excludes envelope contents, hidden state and external file bytes.

Copies use one native undo step. Failed verification attempts to remove only the newly confirmed copy. If native copying throws before its new clip can be identified, or ownership changes, cleanup is skipped and partial state is reported. A lost reply needs inspection of both exact slots before retrying; never delete uncertain content or replay the copy blindly.

## Listen and continue

Audition only when requested or already authorized. Launching the copy can start transport, replace destination Session playback and override Arrangement playback; unrelated tracks can sound. Preserve arms, monitoring, mutes, solos, routing and devices. A muted destination and a successful copy receipt do not prove an audible result. Keep the original and chosen copy. Further musical edits, sound changes, deletion and saving have their own scope.
