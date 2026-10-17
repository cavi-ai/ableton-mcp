# Resample Live output into an instrument

Retrieve `resample-to-instrument` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the source mix/passage, intended instrument role, musical direction and any audition request. `captureBeats` is a numeric string from `1` to `16`, defaulting to `4` quarter-note beats. `collaborative` resolves material choices with the user; `autonomous` chooses within the brief. Retrieval renders guidance without recording or editing Live. Execution requires the `all` profile, an updated bridge and ffmpeg/ffprobe.

## Resolve what will be printed

This workflow records Live's current Resampling signal, including effects, Returns and other sounding parts. Selection does not isolate a stem, and the recording does not prove what reached the speakers. Resolve an isolated-part request before changing mutes, solos or routing. Preserve existing sources and active takes. Loading the new instrument later requires stopped transport; establish whether pausing source playback after the print is within scope before interrupting a performance.

Use the appropriate Session or Arrangement audition workflow when playback needs to be established, and read actual playback after quantization. The print captures the current signal window; it does not guarantee an exact musical start phase or bar range. Its requested beats must fit the native 0.5-30 second bound at the observed tempo. Resolve a longer or exact-range request through the appropriate render workflow or an explicitly chosen shorter passage. Do not silently truncate or stitch unaligned captures.

## Require a complete recording

Follow [Live audio capture](live-audio-capture.md). `capture_live_audio` appends a muted, monitor-off audio track and stops/disarms only that capture. Source playback continues and selection can move. Do not change the capture track, tempo or mix during recording. Require `get_live_audio_capture` to report `complete`, empty `cleanupErrors`, `fileUnchanged: true` and matching `durationEvidence`. A start receipt, nonempty file or `file_ready` status does not establish completion.

Keep the exact recorded `file.path`, size, `mtimeNs`, duration evidence, source context and retained track/clip identities. Analyze only the unchanged complete file within its actual duration, then re-read the capture to check the evidence again. Source waveform or pitch estimates do not determine the musical role or key of a polyphonic mix.

Finish the completed handle and require `captureActive: false`, retaining its muted, unarmed print track and audio. Stop source playback separately when authorized and verify stopped transport/recording before loading. A timeout requires inspecting handles and retained tracks before another print. Runtime handles can disappear on restart; that does not prove the retained file disappeared or that a fresh capture is needed. Preserve partial recordings and uncertainty rather than recreating completion claims.

## Load the print into a new part

Create an intended MIDI staging track, muted and unarmed, and load Simpler from an observed factory browser path. Re-read its actual device ID and sample state. Do not replace an existing instrument or silently bypass an unexpected loaded sample after a lost response.

Plan `load_simpler_sample` for the complete print's exact file. Before confirmation, compare the plan's canonical `sourcePath` and `sourceFile.size`/`mtimeNs` with the retained capture evidence. Changed file metadata or native context requires inspection and a fresh decision. The loader additionally guards inode/device metadata; it does not bind decoded bytes or cache identity. Loading the file does not bake in later changes to the retained print clip's gain, warping or region. If those edits matter, resolve rendering them instead of silently loading the raw recording.

Require the load's verified native readback, then inspect the actual sample path, positive frame length/rate, region and chosen playback mode. The instrument and retained recording share a file; this is not a collected or independent backup. Follow [sample instrument building](sample-instrument.md) for intended region/control edits or [sample chopping](sample-chopping.md) for a manual slice groove.

Create the new MIDI material only in an exact empty staging slot, using the observed song key/meter/grid and resolved note-to-pitch or slice mapping. Verify complete notes and timing. For authorized audition, resolve which sources should keep playing or pause for comparison; do not silently layer the new part over the original or isolate it with unrelated mutes. Read actual playback and ask what the user hears. Additional output recording/measurement needs its own scope; the initial print does not authorize recursive resampling.

Keep the chosen part, print and original sources. After a lost reply, inspect current captures, files, devices and slots, then continue only missing authorized work. Saving, collecting external samples, deleting print tracks and exporting retain their own scope. Report the actual recorded signal/duration, new part, observed playback and remaining musical or provenance uncertainty.
