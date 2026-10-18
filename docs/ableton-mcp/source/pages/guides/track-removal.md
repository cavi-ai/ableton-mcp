# Remove a track or Group

Retrieve `remove-track` through `get_producer_workflow` or its MCP prompt for an explicitly unwanted track. Resolve its exact current identity and contents in both Session and Arrangement, including devices and Group descendants. Preserve originals and preferred alternatives unless their removal is explicit.

Deleting a Group deletes its entire subtree, including nested Groups. Use [ungrouping](track-ungrouping.md) when the children should remain. A track without Session clips can still contain Arrangement clips, processing and automation.

## Review the full scope

Plan `delete_session_object` with `targetType: "track"`, exact `targetId`, fresh `expectedStateVersion` and `allowContent: true`. Content authority is required even for an apparently empty track: the API cannot rule out unexposed automation. A request to remove an entire named track or Group supplies that scope; uncertain identity or removal intent must be resolved first.

Review every `removedTracks` member, its clip inventory, Session/Arrangement counts, device tree and content fingerprint. The updated bridge binds native owners, hierarchy, complete stored notes and exposed audio/timing state, device values and automation state, controls and exposed routing. It rechecks at undo entry before one native deletion call. The last track or last entire Group subtree cannot be removed.

Transport, recording and count-in must be stopped, launches settled and targets unfrozen. Exposed routing or sidechain dependencies from surviving tracks, Returns or Main require separately scoped routing resolution before deletion. Do not silently reroute other parts, stop a performance or remove a different track to bypass refusal.

Limits are 256 tracks, 64 Returns, 1024 scenes, 4096 Session slots plus Arrangement clips, 16384 stored MIDI notes, 512 devices and 32768 parameters across the observed content. Audio clips support 4096 warp markers each. Reads do not sample or truncate content.

## Inspect the result

Read `deleteRequested`, `nativeReturned`, `targetsAbsent`, `deletionVerified`, `existingLayoutPreserved`, `remainingMaterialPreserved`, `controlsPreserved`, `renumberedTrackNames`, `readbackPending`, `observed`, `error` and `observationError` separately. A returned call does not prove a verified outcome. An exception can leave the requested subtree absent; that fact is separate from preservation checks.

Later callbacks require two matching observations within three attempts without repeating deletion. Partial removals remain without automatic rollback or replay. Lost Song access retains dispatch facts with unknown observations. A different Song cannot certify the result. Deletion verification avoids comparing disposed target objects.

Track IDs and numbered labels shift, and selection may move. Resolve current IDs again and independently inspect surviving material, hierarchy, processing, controls and routing. Only the exact index-derived label transition is recognized; arbitrary renaming remains a mismatch.

Hidden plug-in state, complete automation envelopes, modulation relationships and external file bytes are not verified or backed up. The track deletion command does not authorize deleting source files or additional alternatives. Saving follows its own requested scope.
