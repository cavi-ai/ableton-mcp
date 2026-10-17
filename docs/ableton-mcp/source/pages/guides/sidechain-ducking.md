# Set up sidechain ducking

Retrieve `set-up-sidechain-ducking` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the trigger, the part to duck and the intended feel, for example “let the kick make a little room in the bass; keep an alternative.” The default `collaborative` mode resolves material choices with you. `autonomous` chooses a stated starting direction within your brief.

## Resolve and preserve the parts

The trigger feeds the compressor's detector. The target receives the compressor and may be a single track or a Group bus. Read the actual devices, material, routing and mixer state; a track name does not establish an instrument or musical role. A Group target affects its routed children. Changing the trigger's audible output is unnecessary for selecting an external detector source.

For a MIDI part, [instrument comparison](instrument-comparison.md) can create a preserved alternative or reuse an identified comparison. It copies the whole track, starts the alternative muted and unarmed, and shifts subsequent IDs. Resolve the returned identities before another edit. Other native track duplication requires its own intended scope and routing inspection. Editing an existing target in place must be intended. Exposed snapshots cannot reconstruct hidden plug-in state or complete automation.

## Configure the observed compressor

Reuse the intended compressor, or find the actual factory browser path before adding one with `load_browser_item`. Inspect its planned device-chain effect and actual resulting hierarchy. A supported external-sidechain route is separate from track input routing and Return sends.

Read `get_device_sidechain_routing`. Choose an exact, unambiguous `sourceTypeId` from its `availableTypes` with guarded `set_device_sidechain_routing`. Read again before choosing `sourceChannelId` from the refreshed `availableChannels`. These are separate confirmed edits. Inspect the actual pre/post-FX or post-mixer tap; source processing, level and mute can affect detector input differently. Duplicate labels need resolution rather than selecting the first match.

Selecting a source does not enable external detection. Read `list_device_parameters`, then enable the actual exposed external-sidechain control through its native quantized choices with guarded `set_device_parameters`. Its plan binds the native parameter edit context. Resolve threshold, ratio, attack, release, dry/wet and makeup from observed controls. Use `set_device_parameter_display` for supported finite units such as dB and ms; use native bounds and labels for other parameters. Skip unchanged values and respect automation conflicts. Do not guess parameter indices or normalized values. Unsupported routing or parameter meanings remain explicit boundaries.

## Compare in context

Playback needs its own authority. Keep the trigger and target active at the chosen detector tap, and compare the processed alternative with the original using the returned comparison identities. Do not silently solo, reroute or change unrelated mutes to isolate the test. Leave detector listen/audition off when finishing; restore any owned temporary listen setting against fresh context.

Read back routes and settings, check the original's material and controls, and ask what the user hears. Configuration does not prove audible gain reduction, appropriate timing or an improved mix. [Captured-output measurements](live-audio-capture.md) can provide separate evidence but do not establish subjective quality. Keep alternatives until their disposition is chosen. Saving and deleting material remain separate actions. After a partial failure or lost reply, inspect current state before continuing; do not replay the entire configuration sequence or use global undo over manual edits.
