# Create a native track Group

`group-session-tracks` turns an explicit request such as “group these two synth layers as Synth bus” into a native Live Group. It resolves the tracks, creates the Group, inspects its members and routing, and separately applies an authorized name or processing chain.

## Supported sources

In the `all` profile, `group_tracks` uses the macOS English Live track-header menu. It requires a saved Set and two to 64 consecutive ordinary root tracks in Live order. Sources must be ungrouped, unarmed, unfrozen, produce audio and feed Main. MIDI tracks therefore need their instruments already loaded. Playback and recording must be stopped, with no pending launches. The Set may have at most 256 ordinary tracks and 64 Returns; target evidence is bounded to 512 devices, 32,768 parameters, 4,096 slots/Arrangement clips and 16,384 stored MIDI notes.

Set `ABLETON_MCP_LIVE_APP_PATH` to the exact running Live `.app` bundle and grant macOS Accessibility access to the process running the MCP server. See [configuration](../reference/configuration.md).

Resolve exact IDs through `list_tracks` and current routing reads. Do not silently include intervening tracks, reorder the Set, stop recording or change custom routing to make a request eligible. Nested grouping, reparenting, grouping existing Groups and ungrouping are outside this operation.

## Plan and execute

Plan with `trackIds`, fresh `expectedStateVersion` and `expectedSetFingerprint`:

```json
{
  "trackIds": ["track-2", "track-3"],
  "expectedStateVersion": 12,
  "expectedSetFingerprint": "use-the-current-observed-fingerprint"
}
```

The plan is inert. Review target names, outputs, content evidence and the warning. Retain `plan.before.groupingId` before confirming its single-use token and hash. The native context binds track order and objects, exposed target devices/clips/parameters, names, timing, MIDI notes, audio settings, colors and existing mixer/routing controls.

Execution brings the exact Live app into view, selects the exact headers in the current Session or Arrangement view and checks its owned menu. The server rechecks native context before preparation and again before sending Group Tracks. Only an explicit enabled command is pressed. Native readback then resolves the original objects under their new IDs and checks the inserted Group, exact membership/order, exposed material and controls. The UI action cannot be atomic with concurrent manual edits; a mismatch may be detected after a partial change. No automatic undo or ungrouping is attempted.

Grouping changes selection and control-surface focus, inserts a track and routes the requested outputs through the Group to Main. It does not request playback, saving or child content edits. All existing track IDs at and after insertion shift. Re-read affected IDs before subsequent operations.

## Read the actual result

Inspect `groupRequested` separately from `groupVerified`. The returned `observed` record includes `group`, original-to-current `members`, `originalOrderPreserved`, `membershipVerified`, `materialPreserved`, `routingVerified`, `sourceOutputsPreserved`, `controlsPreserved` and `inspectionRequired`. Source outputs intentionally change from Main to Group on success; `sourceOutputsPreserved` describes the earlier routing rather than the new intended route. Inserting the Group advances the native topology version once.

Existing numbered Group labels can shift with insertion. `renumberedGroupNames` reports an accepted transition only when the same retained Group changes from its exact old index-derived label to its exact new one, such as `8-Group` to `9-Group`. Target names stay literal, and every other control and name comparison still applies. The transition does not identify who or what changed the label.

For a lost or partial reply, call `get_track_grouping_status` with the retained `groupingId`. It reads the current native objects without repeating the command. `unchanged` requires the original membership, exposed material, controls and original outputs. `grouped` requires the checked Group postconditions. `changed` requires inspection. Further edits can invalidate the baseline. Handles live in the bridge's bounded runtime cache and can expire or disappear after reload; a missing handle is not evidence that grouping failed. Inspect current tracks before deciding what remains.

Rename the observed Group with a separate fresh `rename_session_object` plan, then refresh context. Inspect member/Group routes and the bus's native dB level before processing. Readback does not prove audio equivalence, headroom, saved state, hidden plug-in state, complete automation envelopes or external file-byte preservation. Unrelated clip contents and device parameters are outside the target-material comparison.
