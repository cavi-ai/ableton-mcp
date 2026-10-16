# Compare instruments while keeping the original

Ask the `explore-selected-instrument` prompt for a direction such as “try warmer synths for this part.” Start by understanding the displayed MIDI clip and its instrument, then choose a candidate together. These comparison tools require the default `all` tool profile and the updated Remote Script.

## Prepare an alternative

`prepare_instrument_comparison` plans a native copy of the exact MIDI track containing the part. The plan names the source track, clip, devices and alternative. Confirmation binds exposed devices, routing, notes, timing and track topology; a changed source requires a fresh plan.

Preparation requires stopped transport and recording off. Pause only when authorized. Live temporarily mutes the source during duplication, then restores its original mute state. The alternative starts muted, unarmed, with solo disabled and input monitoring off. It includes the track's Session and Arrangement material. Exposed device, routing, note and timing readback must match; a failed copy is removed when cleanup succeeds. An incomplete cleanup is reported explicitly.

Insertion shifts subsequent track, clip and device IDs. Use the returned `comparisonId` with `get_instrument_comparison` to resolve the actual pair and original part to their current IDs. Do not reuse cached IDs from before the insertion. A missing part has a null clip ID and must be resolved before auditioning.

The source must be an ordinary, unfrozen MIDI track with arm and solo off and no live-input monitoring. Resolve these conditions explicitly before copying. Limits are 128 Session slots plus Arrangement clips, 4096 notes per clip and 16384 notes per track. No partial sample is substituted for larger material. A track cannot participate in two active comparisons.

## Try a sound on the copy

Load only the chosen candidate onto the alternative track through the usual `load_browser_item` plan and confirmation. Keep the original instrument intact. Read both device chains and complete note/timing baselines before loading, then compare readback afterward. Resolve manual edits with the user rather than overwriting them.

Native track duplication carries the instrument through Live's own copy operation. The bridge verifies exposed state; it cannot independently inspect opaque plug-in state or prove that the copy sounds identical. Parameter snapshots cannot recreate a missing instrument. Listen before judging the sound.

## Audition and choose

`select_instrument_comparison` changes only the pair's mute states in one guarded native step. `original` unmutes the original and mutes the alternative; `variation` does the reverse. `restore` returns the original to its mute state from before preparation and mutes the alternative. Selection preserves notes, devices, manual edits, monitoring, routing and unrelated tracks.

Selection does not launch clips or start or stop transport. It refuses recording, frozen tracks, solo conflicts, armed tracks and live-input monitoring. Resolve these states explicitly rather than changing them silently.

For a sequential Session comparison, launch the chosen part with explicit quantization, listen, stop that part, select the other version, and launch its corresponding clip. Separately launched clips are not proven phase aligned. Arrangement material uses the Arrangement transport; never send an Arrangement clip ID to `launch_clip`. Explain the playback effect and obtain authorization before auditioning. A mute readback does not establish that audio reached the listener.

When the user chooses a version, pass that choice with `finish: true`. Both tracks remain with the selected mute states, and the comparison handle ends. Nothing is deleted or saved automatically. Stop playback separately when requested. Rejected alternatives remain until the user requests deletion.

## Continue after interruption

Omit `comparisonId` from `get_instrument_comparison` to list active comparisons. This can recover the handle after a preparation reply times out or a client reconnects. Read the actual pair before retrying: an already executing native copy can finish after cancellation. Do not blindly create another copy.

Comparison handles are runtime state and are not stored in the Live Set. Reloading scripts or restarting Live may invalidate them. Inspect the existing tracks before beginning again; a missing handle does not mean the tracks were removed. At most 16 comparisons can be active. Finish comparisons to release handles while preserving their tracks.

For a user-requested replacement on the original track instead, create a separate saved working Set first. `save_live_set` saves the named Set but cannot perform Save As; that copy must be made in Live and its path verified before replacing the instrument.
