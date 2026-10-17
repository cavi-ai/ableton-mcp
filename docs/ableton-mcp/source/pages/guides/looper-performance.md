# Keep a Looper performance

Use `keep-looper-performance` through `prompts/get` or `get_producer_workflow` to turn an existing native Looper performance into a named Session audio clip. The workflow also guides an authorized new take and subsequent audition with the user.

## Inspect the source and destination

Resolve the exact Looper, including its rack path, with the device hierarchy. `get_looper_performance_context` reports its exposed State, Quantization, Monitor, Song Control, Tempo Control, routing and transport. Recording or overdubbing changes captured content; restoring the State parameter does not restore audio.

Choose an empty Session slot on an ordinary audio track. `get_looper_export_context` takes `trackId`, `deviceId`, `destinationTrackId` and `destinationClipId`. It reads native capability, buffer length, tempo, state, exposed parameters and destination guards without selecting or launching anything. `loopLength` retains Live's native value without an assumed time unit. Read exported clip timing separately.

## Export without overwriting material

Plan `export_looper_clip` with the same identifiers, fresh `expectedStateVersion` and an optional `name`. Review the plan, then execute with its single-use confirmation token and hash. The bridge rechecks the document, complete native device/container lineage, parameters, buffer length and destination slot identity.

Export requires an available native API, a positive fixed buffer in Stop or Play, no Arrangement or Session recording, an unfrozen source and an empty unfrozen audio destination that is unarmed and has no pending launch. Live also requires an enabled audio engine. The operation does not launch the clip, clear Looper or change routing and processing.

`exportRequested` reports the native call. `clipCreatedVerified` reports an observed audio clip with a source path and positive native length in the intended slot. Read `get_audio_clip_state` and `get_clip_timing` afterward for actual markers, loop and warp settings. Buffer samples are not readable through this API: `bufferContentVerified` remains false, and edits that retain exposed controls and length cannot be detected. Clip creation does not prove audible signal or musical quality.

## Listen and continue

Before audition, resolve whether Looper is still playing: launching the exported clip alongside it can double the signal. Stop only the intended Looper within the user's authority, inspect destination routing/processing, launch the exact clip and observe playback after quantization. Ask what the user hears. The exported clip can then enter the [audio development](audio-clip-development.md) or [Session scene](session-scene-building.md) workflow while retaining the original buffer.

A lost reply or `verificationError` requires inspecting the destination before another export. Partial material is retained; there is no automatic retry, deletion or global undo. Do not clear the original buffer as cleanup. Saving, collecting external audio and deleting material remain separate actions.

The underlying operation is documented in the [Live Object Model Looper reference](https://docs.cycling74.com/apiref/lom/looperdevice/). Older Live versions may not expose it; the context reports capability rather than simulating support.
