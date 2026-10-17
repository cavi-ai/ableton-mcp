# Return a control to automation

Use `resume-parameter-automation` for a request such as “give the bass filter back to its automation.” This workflow hands one exact overridden control back to Live. It does not create or recover an envelope. The tools require the `all` profile and updated bridge.

## Resolve the control

Call `get_parameter_automation_context` with an observed `trackId`: ordinary/Group `track-N`, `return-N` or `master`. Omit `deviceId` to list mixer controls, or supply an observed device ID to list its parameters, including nested devices. Select the exact returned `parameterId` for a focused read.

Device controls use `parameter-N`. Mixer controls include `volume`, `pan`, `left`, `right`, `send-N`, and Main `cueVolume`/`crossfader`. Send rows identify their exact Return. Unsupported controls remain explicit. Native pan controls require the matching Stereo or Split Stereo mode; this workflow does not change mode.

Each row reports native value/display, bounds, enablement, automation state and `reEnableSupported`. Only known `overridden` state 2 is eligible. State 1 already reports active automation; state 0 or unavailable data does not establish an override to resume. Inspection does not change selection, playback or controls. The native API documents [re-enabling automation on one parameter](https://docs.cycling74.com/apiref/lom/deviceparameter/).

The context supports at most 256 ordinary tracks, 64 Returns, 2048 controls on one device and 16 nested rack levels. Choose an exact compatible target rather than guessing IDs after a limit or layout error.

## Confirm the handoff

Plan `re_enable_parameter_automation` with the same target fields, exact `parameterId` and fresh `expectedStateVersion`. The plan binds native owner/device/parameter identities, ancestor Racks and chains, the current manual value, metadata, automation and recording context. Replacements or manual edits invalidate it even when the state version is unchanged. Recording/count-in, frozen or unresolved targets, disabled controls and unavailable native methods are refused.

Review the warning and confirm the unchanged plan. The value may jump or start moving. Group, Return and Main controls affect all routed material at their stage; a macro can affect mapped controls. Playback and the advancing playhead are preserved. Re-enabling automation is a separate intent from changing a control's value; do not use it to bypass an automated-parameter edit refusal.

## Inspect the result

`reEnableRequested` records a native call attempt; `nativeReturned` records its return. `automationControlRestored` requires the same native target to report active automation. Require `verified:true`, inspect `verification`, and independently read the selected context again. The command is requested once, followed by up to three display-tick observations. A returned command alone does not establish a completed handoff.

Readback covers native automation state and current value. It does not identify the source lane, capture its complete envelope, verify a value trajectory or establish audible behavior. Other control values can continue moving while automation plays.

Partial results remain without automatic rollback or replay. After a timeout or lost reply, inspect the current target before further action; active automation does not attribute the change to a particular command. Preserve unrelated overrides and intervening edits. Do not press global re-enable, use global undo or restore a stale manual value as a recovery shortcut. Saving needs its own scope.
