# Print MIDI processing as editable notes

Retrieve `print-processed-midi` through `get_producer_workflow` in the `all` profile or as an MCP prompt. Describe the source Session MIDI clip, destination and intended take length. `recordBeats` accepts a numeric string from 1 to 64 quarter-note beats and defaults to 4. This workflow uses the existing guarded routing, clip launch and recording tools; retrieving it does not operate Live.

## Resolve the source and destination

Choose a source MIDI clip and a different ordinary MIDI track with an empty Session slot. Keep the original clip and MIDI effects. Create a capture track only when requested or already authorized. Retain the source’s notes, timing, devices, mixer and routing for comparison.

Read port routing through `get_track_routing`. Resolve the source to one unambiguous offered routing choice and use its input ID, rather than a `track-N` object ID. Re-read available channels, then choose the observed **Post FX** channel ID. Input channel IDs can change with the selected input type. `get_track_midi_routing` describes note/scale mapping, not these port choices.

Live’s internal MIDI tap is after MIDI effects and before the instrument. It can capture an Arpeggiator’s generated notes without rendering the instrument or audio effects. Plug-in-generated MIDI output uses a different routing surface and needs separate inspection. See [Ableton’s routing documentation](https://www.ableton.com/en/manual/routing-and-i-o/).

Use monitoring off while recording. A new capture-only track without an instrument should use an observed **No Output** choice. Resolve any path back to the source, external output or live monitoring before arming. Preserve source routing and unrelated tracks. Existing destination effects can process the printed notes again during later playback; recording them does not bypass those effects.

## Record and inspect the take

Recording needs its own authority. Require an unfrozen destination, other tracks unarmed, recording off and no pending launches. Resolve count-in, launch and MIDI recording quantization from actual context; do not silently change them. Convert bars using the observed meter.

If needed and authorized, launch the exact source while all tracks are unarmed and verify it is playing. Then arm the destination, re-read readiness and plan `launch_clip` for its empty slot with `recordLengthBeats`, an observed one-shot `launchQuantization` and fresh guards. A capture of a running stream need not begin at the source loop start. Resolve phase-critical requests separately.

`recordingRequested:true` does not establish completion. Observe the exact slot until recording and triggering finish, then inspect its complete MIDI notes and clip timing. Require nonempty notes and compare the observed length with the request. Report mismatches and retain partial takes; never pad or crop them silently. After a lost response, inspect before further input instead of replaying recording.

Compare recorded pitches, timing and note count with the stored source to describe the actual transformation. Random MIDI effects can produce a different performance each time. Note readback does not verify MPE curves, hidden expression, controller automation or audible equivalence. Re-read the source baseline to establish preservation.

## Keep and continue

Stop only the playback intended by the request, verify recording ended and disarm preparation this workflow owns after checking for manual changes. Restore owned routing or monitoring only after comparing current state with the last applied values. Keep conflicts and partial outcomes explicit. A retake needs another empty slot.

The printed clip is editable MIDI. An empty capture track has no instrument and does not prove audible output. Audition, instrument routing, replacement, deletion and saving need their own scope. Follow [Session take recording](session-take.md) for the existing recording guards and [MIDI clip variations](midi-clip-variations.md) for further development.
