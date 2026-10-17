# Ungroup tracks and retain their material

Use `ungroup-session-tracks` for an explicit request such as “ungroup the Synth bus.” The workflow resolves one Group, discloses the bus stage that will disappear and verifies the retained descendants under their current IDs.

## What removal changes

`ungroup_tracks` removes the Group itself, including its devices, gain, pan, mute/solo, sends and output route. Those controls are not transferred to its children. This can change the sound even when every child instrument and note remains intact. Group devices require `allowContent: true` in the confirmed plan; an exposed snapshot cannot restore hidden plug-in state or complete automation.

Direct children move to the removed Group's enclosing Group, or to root when there is no enclosing Group. A child output set to Group feeds that enclosing Group, or changes to Main at root. It does not inherit the removed bus's output route. Existing custom child routes stay in place. Nested Groups inside the removed Group retain their own descendants.

The operation changes native selection and focus. Removing one track shifts later track IDs down by one. Numbered labels can shift too: `renumberedTrackNames` reports only an exact old-index/new-index transition, without attributing its cause. Other label changes fail verification. Re-read affected track IDs before subsequent edits.

## Eligibility and dependencies

The `all` profile requires macOS English Live, a saved Set, stopped playback/recording, no pending launches and unarmed/unfrozen Group descendants. Resolve one nonempty Group from fresh `list_tracks`, routing and Group snapshot reads. Empty Groups use explicit track deletion. A folded target Group is eligible, but enclosing Groups must be unfolded so its header is exposed. Use separate guarded `set_group_fold_state` actions and refresh context when needed.

Set `ABLETON_MCP_LIVE_APP_PATH` to the exact running Live `.app` bundle and grant Accessibility access to the process running the MCP server. The current Session or Arrangement view must expose one matching native header inventory.

Exposed ordinary-track, Return/Main routing or device-sidechain dependencies that refer to the removed Group are refused before the command. Resolve such routes only with appropriate authority; do not silently reroute other parts to make removal eligible. The checks cannot inspect hidden plug-in routing or unexposed modulation relationships.

Limits are 256 ordinary tracks, 64 Returns and 512 devices for exposed dependency inspection. Target evidence for the Group and descendants is bounded to 512 devices, 32,768 parameters, 4,096 slots/Arrangement clips and 16,384 stored MIDI notes. Larger requests are refused rather than sampled.

## Plan, confirm and inspect

Plan with `groupTrackId`, fresh `expectedStateVersion` and `expectedSetFingerprint`. Review `plan.before.removedGroup`, `hasGroupDevices`, descendant names/material, expected output destinations and the warning. Retain `plan.before.ungroupingId` before confirming the single-use token/hash. To authorize device loss, request a fresh plan with `allowContent: true`.

The tool binds native track, device, parameter, clip, Return, scene and Main objects; exposed target material; existing mixer/routing controls; sidechain context; and the visible header order. It rechecks context before preparing the menu and before pressing an explicit enabled Ungroup Tracks command. Both the exact UI selection and Live's native selected Group must match. A changed context stops execution. The UI command cannot be atomic with concurrent manual editing, so a mismatch can still be detected after removal.

Read `ungroupRequested` separately from `ungroupVerified`. The observed result reports `groupRemoved`, `originalOrderPreserved`, `membershipVerified`, `materialPreserved`, `routingVerified`, `controlsPreserved`, descendant source-to-current mappings and `inspectionRequired`. Successful removal advances the native topology version once. Verification covers exposed notes, clip timing/audio settings, child devices/parameters and controls. It does not prove audio equivalence, saved state, hidden plug-in state, complete automation or external file-byte preservation. Unrelated clip contents and device parameters are outside the target-material comparison.

## Lost replies and partial changes

Call `get_track_ungrouping_status` with the retained `ungroupingId`. `unchanged` requires the original graph, Group processing and checked material/controls; `ungrouped` requires the removal postconditions; `changed` requires inspection. This read never repeats removal or rebuilds the Group. Further edits can invalidate the baseline.

Handles live in a bounded runtime cache and can expire or disappear after bridge reload. A missing handle does not show whether removal happened: inspect the current Set. Never automatically undo, regroup or repeat an uncertain command. Saving, playback, printing the original bus sound and any later rebuilding are separate actions.
