# Build a shared Return effect

Retrieve `build-shared-return-effect` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the source parts, effect and desired balance, for example “send the chords and lead to one new room reverb.” `collaborative` resolves material choices with you; `autonomous` chooses a stated starting direction within your brief.

## Preserve the dry path

Parallel Return effects combine each source's existing output with a send to shared processing. Read exact source IDs, devices, material, mixer and routing first. A Group's signal may already include its children; sending both can feed the same material twice. Preserve unrelated sends, levels, mutes and output routes.

`route_tracks_to_return_bus` has a different purpose: it changes source outputs to **Sends Only**. Use individual `set_track_send_db` actions for this parallel workflow so the direct signal remains on its existing route.

## Resolve the Return and output

Use `get_set_mixer` to identify an intended existing Return, or create a dedicated bus with guarded `create_return_track`. Give it a raw name without the automatic bus-letter prefix; retain the returned ID and verify its actual displayed name. After adding a Return, re-read source sends because each track receives another send lane. After a lost creation reply, inspect the actual bus list before repeating the operation.

`get_return_routing` reads one canonical `return-N` ID and reports the exact output type/channel and available choices. It preserves selection, playback and routing. Missing native routing properties produce `supported: false` with null selections and empty choices. Other native read failures remain errors; no assumed destination is returned. More than 512 choices in either field is refused rather than silently truncated.

Check that the destination matches the intended signal path. This tool cannot change Return output routing. Send pre/post mode is not exposed by this workflow and stays unchanged; do not claim a known tap when it has not been observed. For an existing Return, inspect every ordinary track's matching send before changing shared processing or controls, including sources outside the request. Unknown source state requires resolution before affecting that bus.

## Configure and feed the effect

Mute an owned new bus while configuring it with guarded `set_return_mixer`; preserve an existing bus's control state unless changing it is intended. Load an observed factory effect path onto the exact Return with `load_browser_item`, review the planned device-chain effect, and verify the actual order. Resolve controls through `list_device_parameters`. When only adding sends to an existing Return, preserve its effect settings; shared processing changes need explicit scope. For a newly added conventional reverb or delay on an owned new Return, initialize wet-only processing, often 100% Dry/Wet, so the original direct path supplies the dry signal. Resolve the intended topology rather than assuming every effect has the same control.

Use `set_device_parameter_display` for supported finite units, and `set_device_parameters` for observed native values or quantized labels. Respect automation and disabled controls, keep unrelated settings, and read each edit back. A delay's sync, divisions and feedback need observed controls. Exposed parameter snapshots are not complete backups of plug-in state or automation.

Resolve each source's `sendId` and matching `returnTrackId` from its refreshed mixer. Plan and confirm `set_track_send_db` with a finite absolute dB target. Relative changes need an observed finite baseline; a silent send needs an absolute target. Require `observed.verified` and independent readback. Several send edits are separate operations and can partially succeed; inspect actual state after any partial or lost reply.

Verify the Return destination, devices and source sends before unmuting an owned new bus. Audition only with authority, preserve the original dry routes and material, and ask what the user hears. Configuration and playback readback do not establish audible effect level, headroom or musical improvement. [Captured output](live-audio-capture.md) provides separate measurements. Keep the intended bus and sends; saving, deletion and further routing changes remain separate actions. Never use global undo over intervening manual edits.
