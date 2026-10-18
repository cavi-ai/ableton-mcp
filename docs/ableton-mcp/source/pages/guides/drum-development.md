# Develop a drum part

Use `develop-drum-part` for an existing Session MIDI beat: “thin the hats,” “make the last bar less repetitive,” or “add a fill while keeping the kick.” Retrieve the workflow through `get_producer_workflow` or its MCP prompt. Retrieval does not call Live; execution requires the `all` profile and the updated Remote Script bridge.

```json
{
  "workflow": "develop-drum-part",
  "arguments": {
    "request": "Make a named alternative to the verse beat. Keep kick and snare timing, thin the hats and add a final-bar fill. Audition it, then refine from my feedback.",
    "mode": "collaborative"
  }
}
```

The default `collaborative` mode proposes a musical direction unless the user already chose it. `autonomous` chooses within the brief and states its choices. Neither mode grants unrelated playback, device edits, deletion or saving. For a new pattern, use `produce-drum-pattern` after resolving the instrument and pitch mapping.

## Resolve the actual beat

Resolve the requested Session clip even when another clip is displayed. Read its complete notes, timing, instrument hierarchy and routing. Inspect populated Drum Rack pads and their MIDI note numbers; General MIDI conventions and lane labels do not establish this kit's mapping. Populated pads can still be silent. For a plug-in or external kit with an unavailable sound map, retain known pitches and resolve new sound roles before adding hits. `set_drum_pad_state` changes mute/solo; it does not assign sounds. Preserve kit processing, choke relationships, routing and pad controls.

Choose an exact empty slot on the same track and use `duplicate_clip` with source `trackId`/`clipId`, `destinationClipId` and a unique `name`. Verify source and copy content, timing, groove and markers; copied note IDs may differ. Keep the source intact. A lost reply requires inspecting the destination before retrying. Names alone do not establish ownership.

## Choose the right edit

Drum edit ranges use the **clip's meter** and quarter-note clip coordinates. `startBar` is zero-based from clip beat zero; `activeSteps` is one-based within a bar. Read loop and start markers rather than assuming the loop starts at zero. The current song meter does not move the clip's bar origin. Inspect the planner's actual `range.startBeat` and `range.endBeat`, notes outside the loop and notes crossing range boundaries. For a partial-bar or irregular phrase, use exact current note IDs rather than rounding or changing the global meter.

| Intent | Tool path | Effect to review |
| --- | --- | --- |
| Replace a lane's rhythm in whole bars | `plan_drum_pattern_edit`, `edit_drum_pattern_clip` | Replaces the chosen lane notes in the range. Steps repeat in each selected bar. Empty steps clear the lane there. Individual expression, off-grid timing and accents on replaced notes can be lost. |
| Vary selected lanes or add a final-bar fill | `plan_drum_variation`, `apply_drum_variation` | Uses an explicit deterministic seed and timing/velocity amounts. The optional fill adds notes in the final selected bar; it does not replace existing hits. Its pitch is separate from `laneNotes`. Collisions refuse the change. |
| Thin or refine chosen existing hits | `set_midi_note_properties` | Changes explicit current note IDs. Muting can retain hits for later comparison. Preserve properties outside the requested edit. |

`preserveAccentsAbove` protects velocity, not timing. Exclude lanes whose timing must remain fixed, or choose exact note IDs. Do not delete existing hits to make an additive fill fit. Stored timing and note readback do not measure the rendered groove or establish musical quality.

## Listen and continue after edits

Each mutation uses fresh observations and an unchanged confirmed plan. Verify the complete native note set afterward, including unaffected lanes, bars and properties, source material, timing and processing. Retain partial results and inspect them before continuing; do not replay a whole pattern after a stale plan or lost reply.

When listening is authorized, inspect launch mode, quantization, arm/freeze and recording state before `launch_clip`. Launch can start playback, replace the playing clip on its track and override Arrangement. Keep the previous playing reference for a requested return. Separate clip launches do not establish alignment with other parts; a full-row comparison follows [Build a Session scene](session-scene-building.md) and needs its complete effects reviewed. Preserve unrelated mutes, solos, monitoring, arms and global groove.

Read actual playback and native signal activity, then ask what the user hears or make a bounded refinement within the autonomous brief. Neither meters nor stored notes establish what sounded better. Re-read the alternative before further edits and preserve intervening added hits, velocities and timing. Refresh the comparison if the source, kit or phase changes. Keep original and alternative clips; cleanup and saving remain separate.
