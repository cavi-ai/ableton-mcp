# Refine an instrument sound

Retrieve `refine-instrument-sound` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the part and change, such as “make the Analog chords less bright; keep the notes.” The workflow resolves the current instrument and actual exposed controls, proposes a small change, reads it back and compares the result with the user.

## Keep an original

The default `mode: "compare"` uses [instrument comparison](instrument-comparison.md) to prepare one native track copy or reuse an explicitly identified comparison. Its stopped-transport, recording, arm and monitoring requirements still apply. The copy starts muted and unarmed. Resolve current track, device and parameter IDs after insertion; do not reuse the original's IDs. Keep both versions when the user chooses, and finish the handle without deleting tracks automatically.

Use `mode: "in-place"` only when the request or existing authorization chooses editing the existing instrument. Capture the actual current parameter and note/timing baselines first. Parameter JSON excludes hidden plug-in state, automation envelopes, mappings and samples; it is not a complete native preset backup.

## Choose an observed control

Read the instrument hierarchy, factory or supported plug-in context, and exact `list_device_parameters` records. Knowledge groups help locate controls, but do not establish macro assignments or hidden plug-in functions. Use observed enabled IDs, native numeric bounds and quantized labels. A display in Hz does not imply a linear Hz-to-native conversion. A lower low-pass cutoff may reduce brightness; the user judges whether that meets their intent.

Parameter records include `automationState`: `0/none`, `1/playing` or `2/overridden`, with `null` for an unavailable native property and `unknown` for an unrecognized value. These describe current automation ownership, not envelope contents or sound quality. For automated or unresolved controls, use another suitable control or resolve the intended automation interaction before writing. Do not silently override or re-enable automation.

## Apply and compare

For an explicit unit target, use `set_device_parameter_display` in the `all` profile with exact `trackId`, `deviceId`, `parameterId`, `targetDisplay` and fresh `expectedStateVersion`. Examples include `"2 kHz"`, `"200 ms"`, `"-12 dB"` and `"25 %"`. Resolve the actual enabled continuous parameter first. Supported units are Hz/kHz, ms/s, dB and % with decimal points; compatible frequency/time units are converted for comparison. This also works on exposed effect parameters on ordinary, Return and Main tracks, including nested devices.

Planning queries Live's formatter without moving the control. The operation checks observed scale samples for unit changes and monotonicity, finds a raw value whose native display represents the requested quantity, and refuses unsupported or unrepresentable targets without clamping. It does not establish the transfer function between samples or interpret sync labels, unlabeled controls, macro meaning or hidden plug-in state. Never guess a normalized conversion after refusal.

The plan binds the native owner/device/parameter objects and a digest of all exposed parameter records. An intervening mode, value or automation change invalidates it even at the same bridge version. Recording, frozen owners, disabled/quantized controls and active/unknown target automation are refused. Confirm the unchanged plan, require `observed.verified` and independently read native display/value afterward. A changed target uses one undo step; failed readback attempts restoration of only its previous raw value and reports rollback failures. If native owner/device/parameter topology changes during the write, verification fails and restoration is skipped to preserve replacement objects; inspect the actual partial state. `dependentChanges` reports other exposed controls changed by native dependencies when topology is preserved. Hidden state and sound quality are outside verification, and restoring the same displayed quantity may select a different raw value within its display interval.

The updated Remote Script provides a dedicated parameter edit-context read; an older bridge refuses that request before a plan is issued. `set_device_parameters` binds the native device and parameter objects plus each target's automation state and previous value. Replaced objects invalidate the plan even when their exposed metadata match. Native execution preflights the batch and rechecks automation state before each write. A state change invalidates the plan even if the value and state version match. A batch can still fail after earlier controls changed; inspect actual state before retrying.

Read back every affected control, dependent changes and exact notes/timing. Stored values do not prove a timbral improvement or what reached the listener. Audition only when authorized, using the current comparison handle and the existing Session or [Arrangement audition](arrangement-audition.md) workflow. Switching comparison mutes does not require restarting a running loop. Requested recording uses the separate [audio capture](live-audio-capture.md) workflow.

For in-place reversion, make a fresh plan for only the changed controls after comparing current values and automation states with the last applied observation. Preserve intervening edits and resolve conflicts. Restoring values does not restore automation playback/history or hidden plug-in state. Never use global undo to discard a sound after manual edits.
