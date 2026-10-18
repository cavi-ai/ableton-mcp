# Remove a Return effect

Retrieve `remove-return` through `get_producer_workflow` or its MCP prompt for an explicitly unwanted Return. Resolve the exact current Return and its full device chain. Removal discards that Return and its send lane across ordinary tracks, Groups and other Returns. Silence does not establish that stored automation or hidden plug-in state is absent.

Plan `delete_session_object` with `targetType: "return"`, exact `targetId`, fresh `expectedStateVersion` and `allowContent: true`. This authority covers the Return's devices, controls and every send to it. Review `returnRemovalContext.target`, its complete device parameters, and `affectedSends` from all owners, including values, enablement and automation state. The last Return can be removed.

The updated bridge binds native owners, devices, parameters and send destinations, complete exposed ordinary Session/Arrangement contents, hierarchy, mixer/routing, Returns and Main. It rechecks at undo entry before one native deletion call. Stopped transport, recording and count-in and settled launches are required. Exposed incoming routing and sidechain dependencies require separately scoped resolution; do not silently reroute unrelated parts or stop a performance to bypass refusal.

Limits are 256 tracks including Groups, 64 Returns, 1024 scenes, 4096 Session slots plus Arrangement clips, 16384 stored MIDI notes, 512 devices and 32768 parameters. Audio clips support 4096 warp markers each. Reads do not sample or truncate content.

Inspect `deleteRequested`, `nativeReturned`, `targetAbsent`, `deletionVerified`, `existingLayoutPreserved`, `remainingMaterialPreserved`, `sendDestinationsPreserved`, `controlsPreserved`, `renumberedReturnNames`, `readbackPending`, `observed`, `error` and `observationError` separately. A returned call is not proof of a verified result. A native exception can leave the Return absent; read that fact separately from preservation checks.

Later callbacks require two matching observations within three attempts without replay. Lost Song access retains dispatch facts with unknown observations. A different Song cannot certify the result. Disposed targets and removed send parameters are not compared after deletion. Partial outcomes remain without automatic rollback or replay.

Return IDs, send IDs and lettered labels can shift. Resolve current IDs again and independently inspect remaining device chains, each retained send's destination and controls, ordinary material, routing and Main. Only an exact index-derived letter transition is recognized. Available routing choices naturally lose the deleted destination; selected surviving routes must remain unchanged. Exposed send pre/post settings are checked when available.

Hidden plug-in state, full automation envelopes, modulation relationships and external file bytes are not verified or backed up. These checks do not establish audio equivalence or authorize deleting source files or other alternatives. Save only within the requested saving scope.
