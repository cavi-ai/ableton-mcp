# Compare native device A/B states

Use `compare-device-ab` to compare settings on one supported device without duplicating its track. The workflow requires the `all` profile and an updated bridge. [Live's device API](https://docs.cycling74.com/apiref/lom/device/) exposes A/B support, the active A/B slot and a command to copy current state to the other slot; availability depends on the actual device.

## Resolve and preserve

Read `get_device_ab_context` with exact `trackId` and `deviceId`, including a nested path when needed. Track, Return and Main device owners are supported. The read preserves focus and playback and reports native capability, active slot, exposed parameters and automation, recording, freeze state and native identity. It supports at most 2048 exposed parameters. Unsupported devices return `supported: false` and no active slot.

The inactive slot's contents and hidden device state are unavailable. Switching between existing user states is different from preparing a new alternative. For a new alternative, retain the current slot as original and use the other as variation only when replacing that other slot is explicitly authorized. An existing comparison may contain unseen manual edits; do not assume it is empty. Use the [track-copy comparison](instrument-refinement.md) when that preservation boundary conflicts with the brief.

## Copy and refine

Plan `copy_device_ab_slot` with `overwriteOtherSlot: true` and fresh `expectedStateVersion`. Review its warning before confirming. This discards the previous other-slot state without backing it up. Plans bind document, owner/device/parameter identity, current exposed controls, active slot and recording/playback context. Manual edits in these observations invalidate the plan. Hidden edits outside those observations are not reserved.

The result distinguishes `copyRequested` from `copyVerified`, which stays false because the inactive hidden state cannot be independently inspected. `observedCurrentStatePreserved` compares the active slot and exposed controls; it is not a full state guarantee. Resolve any `verificationError` or changed current state before continuing. There is no automatic retry or rollback.

Select the variation with a separately confirmed `select_device_ab_slot` request and `targetSlot: "A"` or `"B"`. Require `slotVerified`, then independently read the actual slot and parameter records. Compare exposed controls with the retained baseline before refining. Parameter objects can change during native selection; refresh identities and plans. Refine only the variation through the usual guarded parameter tools, retaining notes, timing, routing and unrelated processing.

Both mutations refuse recording, frozen owners and active or unknown parameter automation. They do not stop playback or clear automation to bypass those boundaries. This checks current exposed automation state, not every stored envelope. Native A/B states do not share automation: switching can disable automation without re-enabling it when returning. Plans warn about this and `automationPreservationVerified` stays false. Do not promise preservation or re-enable automation automatically; inspect the intended lanes and resolve that consequence before using A/B on an automated device. See [Live's A/B comparison behavior](https://www.ableton.com/en/manual/working-with-instruments-and-effects/#device-ab-comparison).

## Compare and choose

Use authorized Session or Arrangement playback for the intended part. A/B selection changes the device state without launching clips or changing transport. It does not schedule a beat boundary, match levels or establish audible output, sound quality or hidden-preset equivalence. Ask what the user hears, resolve level differences and keep the chosen slot active. Do not overwrite the rejected slot automatically.

After interruption, inspect the actual native device and both available observations before any retry. Slot contents are not independent track/file backups, and the tools do not promise persistence through every save or reload. An overwritten inactive state cannot be reconstructed from the current parameter list. Preserve partial state and manual edits; never blindly repeat a copy or use global undo. Saving, further overwrites, deletion and device replacement each need their intended scope.
