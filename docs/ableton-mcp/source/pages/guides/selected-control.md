# Edit the selected control

Use `edit-selected-control` through `get_producer_workflow` or its MCP prompt for a request about the parameter selected in Live. The `all` profile provides `get_selected_parameter_context` and `set_selected_parameter`.

## Resolve what is selected

The read resolves Live's native [selected parameter](https://docs.cycling74.com/apiref/lom/song_view/) into exact device or track, Return, or Main mixer IDs. Nested regular and return-chain devices are supported through canonical ancestry. It does not assume the selected track owns the parameter, move focus, select another control or change a value.

`status: "selected"` includes `target`, `control`, `selectionToken`, `automationContext` and known edit-safety flags. `none`, `unavailable` and `unresolved` are distinct and return null targets and tokens. Chain mixer controls, hidden plug-in controls and unsupported or ambiguous ancestry are unresolved. Lookup is bounded to 256 ordinary tracks, 64 Returns, 16 rack levels, 4096 devices per container and 2048 parameters per device; it does not scan arbitrary hidden controls.

The native selection can persist after focus moves. It does not prove what the user is hovering over, the foreground widget or intent to edit. Identify the resolved owner/control before applying the request. Explicitly named targets use their exact-target workflows when they differ from this selection.

## Choose an actual target value

Use `value` for an explicit absolute native value within observed bounds. Quantized controls require an integer; `nativeChoiceLabels` lists native integer/display pairs for layouts of at most 32 positions when formatting is available. `valueItems` preserves native labels without inventing an index mapping for other layouts.

For a continuous parameter, `targetDisplay` resolves a finite value in Hz/kHz, ms/s, dB or % through Live's formatter without changing the parameter. Other units, unrepresentable labels, non-monotonic displays and infinity targets refuse. Do not infer a raw-to-unit curve. Supply exactly one target form.

## Confirm and inspect

Plan with fresh `expectedStateVersion` and `expectedSelectionToken` equal to the current token. Native execution rechecks selection, native identity, current value and edit context immediately before one value write. A selection change can refuse an old plan even at the same state version. The token is a bounded current observation, not a lock or a history of every intervening selection.

Active or unknown automation, recording/count-in, frozen/unknown state, disabled controls and an inactive pan mode refuse. An already-overridden manual control can be edited while preserving its automation state. Explicit takeover or handback uses the separate [automation workflow](parameter-automation.md). A refusal does not grant authority to suspend automation or alter recording.

Inspect `nativeReturned`, `verified`, `selectionPreserved`, `verification`, `observed`, `selection`, `error` and `observationError` separately. The write does not change focus or global playback. Partial work remains without rollback or replay. After a lost reply, inspect the exact target's current value before planning remaining work; do not replay a relative edit or restore a stale value. Native value readback does not prove audible output, hidden plug-in state or musical improvement.
