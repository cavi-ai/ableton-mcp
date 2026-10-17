# Add a shared send effect

Retrieve `add-send-effect` through `get_producer_workflow` or its MCP prompt. Describe the parts, reverb/delay or other parallel effect, intended Return and desired balance. `collaborative` resolves material choices with the user; `autonomous` chooses within the brief. Rendering the workflow does not observe or change Live. Execution requires the `all` profile and updated bridge.

## Preserve the dry parts

Read each source's actual mixer and routing, retaining faders, other sends, monitoring, instruments and musical material. Resolve Groups and their children deliberately. This workflow changes selected track-to-Return sends while preserving dry outputs. `route_tracks_to_return_bus` switches sources to Sends Only for serial processing and is not the parallel-send operation.

An existing Return can already serve other parts. Reusing its send does not authorize changing its shared processing, blend, fader, mute/solo or output. Choose a new Return when independent processing is needed rather than silently repurposing the existing bus.

## Inspect the destination

`get_return_routing` reads one exact `returnTrackId` from `get_set_mixer`. It returns the native current output type/channel and available choices without changing them or assuming ordinary-track input/monitoring controls. Unsupported native properties fail explicitly. Routing IDs can be labels rather than persistent object identities: re-read after renaming or topology changes. This reader does not provide a Return-routing write or prove audio flow.

Append a new bus with guarded `create_return_track` when intended. Supply the raw label; Live adds its bus-letter prefix. Retain the returned ID and observed name. Appending adds a new send lane to tracks, so re-read actual sends before balancing them. Preserve existing Return and track levels, and do not introduce Return-to-Return feedback paths.

For a new effect, resolve its exact browser item and load onto the chosen Return using the normal confirmation guard. Require device-chain evidence and inspect actual device IDs and parameters. Configure a new parallel effect's Dry/Wet to 100% only when that is the intended design and the exposed control supports the percent target. Use native display editing; do not guess raw values or force every device in a chain to the same blend.

## Balance and refine

Use `set_track_send_db` with the source's exact `sendId`, matching `returnTrackId`, and absolute native dB target. A relative change needs a finite observed baseline; silence is not a finite starting value. The explicitly silent minimum is `sendDb: "-inf"`. Follow [native send guards](mix-balance.md), require verified readback and independently compare source routing, faders, neighboring sends and Return state. Send pre/post settings are outside these tools; do not assume they were changed.

Creation, effect loading and individual sends are separate operations. After a lost reply, inspect the retained Return, chain and levels before continuing only missing authorized work. Keep partial state; do not append another bus, reload processing or use global undo automatically. Restore only owned controls against fresh identity/value observations, preserving manual edits.

Listen only when authorized, inspect [native signal activity](signal-diagnosis.md), and ask what the user hears. Shared buses and Main can include other parts. Readback and meters do not prove audible improvement or speaker output; separately requested recordings follow [Live audio capture](live-audio-capture.md). Saving and deleting the Return remain separately scoped actions.
