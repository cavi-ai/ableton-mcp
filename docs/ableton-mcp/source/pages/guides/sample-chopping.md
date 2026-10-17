# Chop a sample into a groove

Retrieve `chop-sample-groove` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the sample or part, the intended cuts, groove density/length and any audition request. `collaborative` resolves material choices with the user; `autonomous` chooses within the brief. Retrieving the workflow does not execute it.

## Preserve the part and choose cuts

Read the exact loaded Simpler, sample path, frame bounds and native controls with `get_simpler_sample_state`. Use [instrument comparison](instrument-comparison.md) to preserve an existing part and resolve the actual alternative device after duplication. Keep the original and copied MIDI clip. For a new instrument, follow [sample instrument building](sample-instrument.md). Do not reload a correct sample just to change its slicing mode.

Choose cuts against the actual source. Source analysis can suggest attacks, but transient candidates are approximate source seconds, not guaranteed musical boundaries or clip beats. Multiply source seconds by the observed sample rate and choose integer rounding explicitly. Keep attacks/tails that matter to the brief. A smaller active region can be set with `set_simpler_sample_region`; re-read the resulting bounds before slicing. These operations do not crop the file.

## Set a complete manual layout

Plan `set_simpler_manual_slices` with exact `trackId`, `deviceId`, fresh `expectedStateVersion`, and `slicesFrames`. The complete playable list must contain 1-64 strictly increasing integer frames. It must begin at the observed `startMarkerFrames`, and every position must be strictly below `endMarkerFrames`. An identical layout/mode request is refused without clearing it again.

Optional `slicingPlaybackMode` chooses `mono`, `poly` or `thru`; omission preserves the observed setting. Mono plays one slice, Poly permits overlap, and Thru continues from a triggered slice through the remaining sample region. The tool selects Slicing playback and Manual slice style, disables Pad Slicing, clears prior manual cuts and inserts the exact requested positions through the [native sample API](https://docs.cycling74.com/apiref/lom/sample/).

**Clearing removes manual cuts outside the active region too.** The exposed playable slice list cannot back up those hidden cuts. Preserve a native original before replacing an existing layout. The tool requires a stopped, inactive, unarmed, unfrozen single-sample target without input monitoring, recording or pending launches. It binds the complete exposed native context and object identities; execution rechecks ownership after each change and verifies the actual layout, modes and retained source properties.

Read the actual sample independently after execution. `verified` and `sampleIdentityRetained` cover the native playable slice positions, modes and retained loaded sample, not hidden cut history, decoded bytes or musical quality. A mode change can alter the parameter surface; resolve fresh IDs for later parameter edits. Failure can leave a partial layout. No automatic rollback is attempted: inspect actual state before fresh planning, preserve intervening edits and avoid blind replay or global undo.

## Write and hear the groove

Resolve the note path before programming the whole pattern. MIDI 36 upward is a starting reference for an ordinary Simpler path; test the intended slice order through authorized short notes and actual playback. Rack key zones, MIDI effects and transposition can change the result. A Simpler inside a Drum Rack may receive only one mapped note; do not silently alter rack routing to make a chromatic pattern work. Native slice order alone does not verify the complete note path.

Create the new pattern in an exact empty Session slot, retaining the copied clip and original. Build rests, velocities, gates and loop length from the musical brief and observed song grid. Treat slice choices as timbres, not pitches to force into a scale. Verify complete MIDI readback and clip timing. Pad Slicing stays disabled so an extra note cannot create an unintended cut.

For an authorized comparison, switch the pair's mutes with its actual handle and launch the exact original or new slice-pattern clip. The handle's copied clip is not automatically the new pattern. Preserve unrelated tracks; global playback can include other material. Ask what the user hears. Separately requested measurement follows [Live audio capture](live-audio-capture.md), with complete duration and file provenance checks. Readback and measurements do not establish musical improvement.

Keep the chosen version and original. After a lost reply, inspect current slices, modes, pattern slots and handles, then continue only missing authorized work. Saving, collecting external samples, deleting alternatives, converting to Drum Rack and exporting individual slices retain their own scope. Manual slices share the source file; they are not independent audio backups.
