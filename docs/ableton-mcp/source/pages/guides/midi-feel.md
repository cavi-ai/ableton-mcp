# Match MIDI feel

Use `match-midi-feel` through the MCP prompt or `get_producer_workflow` for requests such as “give the bass the hat timing, with lighter accents.” Specify the source passage, target part or note lanes, desired strength and any audition intent. Retrieving the workflow returns guidance without calling Live. Collaborative mode resolves material choices; autonomous mode chooses bounded grid, cycle and blend settings within the brief.

## Measure the intended events

Read complete notes and clip timing before choosing IDs. `analyze_midi_feel` measures stored MIDI starts and velocities by `straight16`, `eighthTriplet` or `sixteenthTriplet` slots over one to eight bars in the clip's meter. Supply `noteIds` to select exact source events; omission includes all stored events, including notes outside the active loop, muted notes and probabilistic notes. The result reports selected and total source counts. It does not measure what actually played, device timing, native groove playback or audio transients.

Supply `originBeats` for the start of the repeating cycle in the source clip's beat coordinates. It defaults to zero; the active loop start is not chosen automatically. An origin changes slot phase, not which notes are measured. Select note IDs separately for the desired range and lanes. The measured template retains the source selection and origin as context; those fields are not authenticated historical evidence.

For example, a source note at beat 1.30, with origin 1 and a sixteenth grid, belongs to slot 1 with a +0.05-beat offset. Transferring it at full timing strength to a target note at 2.25 with target origin 2 places the target at 2.30. Source and target origins can differ while their cycles align.

Templates with an assigned native groove cannot be transferred. Resolve an unassigned source or separately authorized native work; do not silently remove or bake a groove. `save_midi_feel_template` accepts the same selection and origin when the user requests a named private template. It never overwrites. Inspect names with `list_saved_snapshots` using `kind: "midi-feel"`, and retrieve one with `load_midi_feel_template`. Existing templates without origin metadata retain their measured slot meaning.

## Keep an original and review the changes

Copy the target into an exact empty Session slot using `duplicate_clip` or `duplicate_midi_clip_variations`; an Arrangement copy requires a nonoverlapping interval and verified timeline identity. Read the copy's actual notes and IDs again. Native duplication does not establish hidden device state, envelope retargeting or audible equivalence.

Plan `apply_midi_feel_template` with the measured template, exact target `noteIds`, target `originBeats`, and separate `timingAmount` and `velocityAmount` between zero and one. At least one amount must be positive. Omission of target IDs considers all notes at populated slots. A zero timing amount preserves starts; a zero velocity amount preserves velocities. Timing blends from the current start toward its nearest origin-relative grid point plus the source mean offset. Unpopulated source slots remain unchanged. The target bar length must match, the grid must divide the bar, and an assigned target groove is refused.

The guarded plan binds the target origin, full prior notes and native clip timing. It changes only intended starts and velocities, retaining IDs, pitch, duration, probability, velocity deviation, release velocity and mute. Bounds use observed absolute clip endpoints, rather than treating a nonzero loop's duration as its absolute end. Review the proposed changes and overlaps; refusal is not permission to truncate notes, clamp timing or move clip markers. Confirm the unchanged plan, then independently read complete notes and timing, including the preserved originals.

Audition only when authorized, launch exact alternatives and inspect actual playback after quantization. Same-track alternatives share an instrument; switching clips can change the playing part. Preserve other tracks and the current performance. Ask what the user hears: matching stored events does not prove better groove or audible equivalence.

For a different absolute blend, start from a fresh copy of the preserved original. Repeating a blend on an edited copy compounds it: two 50% timing blends reach 75% of the original distance to the template. Keep earlier alternatives and manual edits unless their removal or replacement is separately intended. After an error or lost reply, inspect existing copies and notes before continuing; do not replay the blend or use global undo. Saving a template and saving the Live Set are separate actions.
