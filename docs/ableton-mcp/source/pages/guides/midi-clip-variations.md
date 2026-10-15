# Develop a selected MIDI clip

Select a Session MIDI clip in Live and open it in the Clip Detail View. In your MCP client, use the `develop-selected-midi-clip` prompt with a musical request such as “Give me two less busy versions, keeping the kick and snare.” Both `core` and `all` profiles expose the tools this workflow needs.

The agent reads the displayed clip, its notes and timing, and the available Session slots. It creates two named copies in existing empty slots on the same track, then edits the copies using their own native note IDs. The original stays in place. If there is no suitable selected clip or not enough space, the agent asks you to select a clip or make room.

Ask to audition an alternative when you want to hear it. Launching a Session clip replaces the playing Session clip on that track and may start playback. The workflow does not automatically solo tracks, change monitoring or arm recording. Ask to stop, return to the original, or continue refining a named alternative.

You can edit a variation yourself between requests. Before continuing, the agent reads its current notes and timing and applies only the requested changes. Old plans are refused when their observed content changes. A stale plan is not permission to restore an earlier version of the clip. Choosing an alternative leaves the original and other copies in place; removing them is a separate request.

## Tools and boundaries

- `get_selection_context` reports the selected track, scene, device, displayed clip and highlighted Session slot without changing focus. The displayed clip and highlighted slot may differ. Unresolved selections are `null`.
- `duplicate_midi_clip_variations` creates one to four named Session MIDI copies in a single undo step. It binds the observed source and empty destinations to the confirmation plan, checks copied notes and timing inside Live, and removes its new copies if creation fails. Recording, pending launches and frozen tracks are refused.
- Copies start identical. `set_midi_note_properties` edits each alternative; `launch_clip` auditions it using explicit launch quantization. Each mutation retains the standard [confirmation contract](guarded-mutations.md).

Native duplication carries clip content, but verification independently checks only exposed notes, markers and timing. It does not inspect hidden per-note expression or every automation envelope. Stored-state readback does not establish audible output or musical quality. This workflow does not capture processed audio, provide sample-accurate scheduling, or cancel an already executing native operation.
