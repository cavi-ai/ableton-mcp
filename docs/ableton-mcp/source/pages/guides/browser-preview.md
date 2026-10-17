# Audition browser sounds before loading

Use `audition-browser-sounds` through `get_producer_workflow` or its MCP prompt to choose sounds with the user before loading them. The `all` profile provides `get_browser_preview_context` and `set_browser_preview`. Preview controls require the updated bridge and native `preview_item` and `stop_preview` support.

## Resolve the exact item

Browse or search actual Live roots and use an exact returned `root` and nonempty `path`. Read `get_browser_preview_context` with those arguments for item metadata, command availability and document/selection guards. Omit both arguments to inspect command availability for a global stop. Reads and dry-run plans send no preview input.

Plan `set_browser_preview` with `action: "start"`, the exact item and fresh `expectedStateVersion`. Start requires recording and count-in off, a non-folder item and available native start/stop commands. It preserves playback and does not load the item onto a track. Available commands do not establish that a particular sample or preset has a preview. Item metadata and URI are bound; preview file contents are not hashed.

## Listen and choose

Starting a preview affects Live's global browser preview and can replace one the user started. Review that effect before confirming the unchanged plan. Native document topology, selection, recording state and item metadata are rechecked immediately before one command. A moving playhead does not invalidate a plan, but a changed playback state does.

`commandRequested` records the attempted command and `nativeReturned` records a normal native return. `contextPreserved` compares the exposed document/selection/transport context afterward. Inspect `error` and `observed` independently. The result does not observe current preview activity, ownership, duration, cue routing or sound at the speakers: `previewVerified` and `audibleOutputVerified` remain false. Ask what the user hears; an accepted call is not listening evidence. There is no automatic retry or cleanup after an uncertain result.

## Stop or load deliberately

For an intended stop, plan `set_browser_preview` with `action: "stop"`, fresh `expectedStateVersion` and no item arguments. This invokes global browser stop, including any later manual preview. It remains available during recording, does not stop transport and does not verify silence. There is no preview handle or exclusive ownership; do not schedule an automatic stop or use a stale plan after manual browser activity.

Loading a chosen item is a separate operation. Use the exact browser path and an authorized compatible destination with `load_browser_item`, then inspect its actual device, clip and track effects. Previewing does not establish native preset recall or audible equivalence in the Set. See [native device presets](native-device-presets.md) for saving and checking a chosen sound.
