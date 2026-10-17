# Move between manual control and automation

Use `take-manual-control` when the intended action is explicit: for example, “hold the bass filter at 2 kHz instead of following its automation.” A general value-change request or a refused normal edit does not authorize suspending automation. The workflow preserves the envelope and changes one exact control. It requires the `all` profile and updated bridge.

## Take manual control

Resolve the exact ordinary track, Group, Return or Main, optional device, and control through `get_parameter_automation_context`. Only known active automation (state 1) or an existing manual override (state 2) is eligible. Inactive controls use the normal value-editing tools. Controls must be enabled, unfrozen and supported for a later handoff. Recording/count-in and unresolved pan modes refuse.

Plan `override_parameter_automation` with `trackId`, optional `deviceId`, exact `parameterId` and fresh `expectedStateVersion`. Choose exactly one absolute `value` within native bounds or `targetDisplay`, a finite continuous native display in Hz/kHz, ms/s, dB or %. Live's formatter resolves the target without writing or guessing a conversion. Quantized controls require an observed integer choice; other display formats, including pan positions, use raw native values. Targets are not clamped.

The plan reports its resolved target and an informational `sampledControl`. With `valuePolicy: advancingAutomation`, the active control's value can keep moving before confirmation; this expected movement is excluded from the plan binding. With `manualValueBound`, the existing manual value is bound. A new manual takeover, manual edit, replaced control or Rack ancestry, changed automation state, changed target interpretation or changed transport context invalidates the plan. Group, Return, Main and macro controls can affect routed or mapped material.

Confirm the unchanged plan. Require `verified:true`, `automationOverridden:true` and independent state-2 readback at the target. `valueWriteRequested` records an attempt; `nativeReturned` records the setter's return. A matching value alone is insufficient. An equal-value write may leave automation active; the result remains partial rather than nudging the control or replaying the write.

This is one immediate value write followed by up to three display-tick observations. Playback continues. It does not record a gesture, edit an envelope, establish audible behavior or grant an exclusive control lease. Later user actions, scenes or controllers may change ownership. Partial work remains without rollback or replay. After a lost reply, inspect the exact current control before further action. Handing control back is a separate explicit intent; there is no automatic timer.

## Resume automation

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
