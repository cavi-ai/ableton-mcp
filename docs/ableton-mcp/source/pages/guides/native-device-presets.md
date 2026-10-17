# Keep a device sound as a native preset

Use `keep-device-sound` through `get_producer_workflow` to keep a useful device or rack in the User Library, then recall it separately. `save_native_device_preset` is available in the `all` profile and uses Live’s native **Save Preset** button.

## Choose and prepare the source

Read the exact device identity and exposed settings. Pass `trackId`, `deviceId`, a new `name` without an extension and fresh `expectedStateVersion`. Ordinary tracks, Returns, Main and nested device paths use their existing native IDs. The tool requires a saved Set, stopped playback/recording, an unfrozen target, no pending launches, macOS English Live 12 and the updated bridge.

Planning reads the source and configured User Library without changing focus or device settings. It rejects names already present among native preset files in the Library root or `Presets` subtree, including case variants. Name stems are limited to 80 visible characters and cannot contain paths or control characters. The native preset scan supports at most 250000 entries, 10000 directories and 32 nested levels. A directory leaving the Library or an incomplete scan refuses execution.

Confirmed preparation sets the intended preset name on the device, selects the exact native source and focuses its device view. Nested targets open their ancestor rack chain lists. Execution binds the selected track header, full device path and selected chain index in every ancestor rack; ambiguous or unavailable ownership refuses Save. Live may rename that source. Partial preparation can leave a naming change even when Save is refused; inspect `observed` and `sourceNameChanged`. Exposed parameter readback does not capture all naming metadata or hidden plug-in state. Prepare an authorized duplicate first if the original’s metadata must remain exact.

## Save and inspect the result

Execution rechecks source material, native selection, destination and the exact focused device’s Save Preset button. Live can create the file immediately when that button is pressed. Only the owned browser naming field with the intended filename is committed. Existing overwrite, sample-copy or unrelated dialogs are never accepted automatically. Unknown saves are not replayed, undone or deleted.

`presetSaveVerified:true` requires an idle native UI, a new artifact and unchanged native source identity/exposed material, apart from the source’s top-level name. `artifact` includes the actual path, byte count, native format and SHA-256. Validation supports Live 12 gzip/XML `.adv` and `.adg` files, and bounded VST3 component-state tables. Audio Unit `.aupreset` files currently withhold verification because component identity and state validation are unsupported. Files and decompressed XML are limited to 64 MiB. Unsupported formats or schemas withhold verification.

Saving uses the current device state and Live’s sample collection preferences. It does not preserve every A/B alternative, certify dependent samples or libraries, install plug-ins or licenses, or save the Live Set. See [Ableton’s device preset documentation](https://www.ableton.com/en/manual/working-with-instruments-and-effects/) for native behavior.

## Verify recall separately

Find the exact item using `search_browser_items` under `user_library`; use the returned path with `load_browser_item`. Browser indexing may lag file creation. Load into a compatible empty staging track rather than assume the browser will replace a current device. Compare the loaded native class and complete exposed parameter names and values with the source. Racks need their exposed nested topology checked too. Saving a child device does not include its parent rack’s macro mappings, chain mixer or routing. A mapped control can therefore become enabled when the child is recalled on its own; save the containing rack when those relationships are required.

`recallVerified`, `audibleEquivalenceVerified` and `completeStatePreservationVerified` remain false in the save result. File checks do not establish those outcomes. Use an authorized passage and actual listening or audio evidence for the intended audible comparison. Keep the source available for revision and report preset saving, recall, listening and Set saving separately.
