# Duck one part against another

Use `duck-against-source` or `set-up-sidechain-ducking` through the MCP prompt or `get_producer_workflow` for requests such as “make room for the kick on the bass.” Describe the trigger, the part to duck, the desired strength or movement, and whether to audition. Retrieving the workflow only returns guidance; it does not call Live or configure a processor automatically.

`mode: "collaborative"` is the default. Materially different source, target, processor and character choices are resolved with the user. `mode: "autonomous"` lets the agent choose bounded initial settings within the brief. Both modes use the same guarded operations and preserve unrelated parts and manual edits.

## Keep the two audio paths

For a preserved MIDI alternative, [instrument comparison](instrument-comparison.md) copies the whole track and starts the alternative muted and unarmed. Track IDs shift: resolve the returned identities before another edit. Reuse an identified alternative rather than making repeated copies. Editing the existing target in place must be intended; exposed snapshots cannot reconstruct hidden plug-in state or complete automation.

Resolve exact track IDs and the target device hierarchy first. A processor on a Group affects its routed children. Reuse an existing compressor only with authority to change that processor, or load a new exact factory Compressor and verify its insertion and the preserved device order. Loading a new effect does not authorize replacing an instrument or changing source processing, notes, faders, sends, monitoring or output routing. The workflow checks recording context and defers setup while recording is active.

`get_device_sidechain_routing` reads the selected device's actual external source and channel choices. Unsupported devices are reported explicitly. Device detector routing is separate from track input routing; selecting a sidechain should keep both original audio paths. The processor's external-enable control is also separate from source selection. Resolve the actual parameter and native choices; an enabled S/C switch alone does not establish a working trigger.

Set one `sourceTypeId` with `set_device_sidechain_routing`, read back the result, then read the refreshed channel list before selecting one `sourceChannelId`. Pre FX, Post FX and Post Mixer are different taps; choose from the observed native labels. Post Mixer can follow source mixer changes. Duplicate source names and device/rack taps need explicit disambiguation. Do not infer routing IDs from track names or reuse stale channel choices. If native routing IDs remain ambiguous, leave routing unchanged and resolve a distinct supported source; renaming parts is a separate edit. See the [native Compressor routing reference](https://docs.cycling74.com/apiref/lom/compressordevice/).

## Shape and refine

Use `get_factory_device_context` and `list_device_parameters` to inspect the actual processor. `set_device_parameter_display` supports finite native dB, ms/s and percent targets, including threshold, attack/release and blend when exposed. It rejects automation, recording and unrepresentable values. Ratio displays are outside that unit setter: preserve the observed ratio or use an independently established native value or exact exposed quantized label. Do not infer a ratio from a normalized number. Preserve makeup, gain, detector mode and other controls unless their change is intended; detector listening needs separate scope.

Loading, external enable, source, channel and parameter edits are separate guarded operations. Inspect each result and independently read back configuration. After an error or lost reply, inspect partial state and continue only missing authorized changes. Avoid duplicate loads, sequence replay, global undo and deletion of partial work. Compare actual selected routing fields when checking preservation; the available choice catalog can change as devices or tracks are added.

Audition only within the user's authority. During the intended passage, `get_track_signal_activity` can observe the trigger, target and Main with the `all` profile and updated bridge. These native snapshots are not simultaneous or isolated, and do not expose compressor gain reduction or prove audible ducking. A zero can miss an intermittent trigger; unavailable readings remain unknown. Separately authorized recording follows [Live audio capture](live-audio-capture.md) and includes other sounding parts.

Ask what the user hears and refine the chosen threshold, timing, blend or authorized routing with fresh guards. Report configuration, observed playback and listening judgment separately. Preserve later manual changes; bypass, restoration, deletion and saving each need their own scope and current identity/value checks.
