# Understand an Arrangement passage

Use `analyze_arrangement_section` when a question concerns one shared passage rather than several independent clip loops. Supply `startBeats` and `endBeats` as zero-based quarter-note song time, with an increasing range of at most 512 beats. Optionally supply unique ordinary `trackIds`; omitting them inspects all ordinary audio/MIDI tracks, up to 64. Group, Return and Main tracks are not clip owners; explicitly requested Group tracks are refused. The tool requires the `all` profile and the updated Remote Script.

Resolve section names and boundaries with the user and `list_arrangement_cue_points`. A locator does not establish an ending by itself. The current time signature does not establish a bar map across meter changes. Resolve unclear boundaries before interpreting a section.

## Read the passage

One Live callback reads the chosen tracks, overlapping Arrangement clips, stored MIDI notes, local loop/start/end markers, current configuration and transport. The requested range is half open: clips ending at its start or beginning at its end are excluded. Session clips and take lanes are outside this scope. Reading does not move focus, change notes or start playback.

Each eligible MIDI clip reports its native `timeline`, local `clipTiming`, intersecting `sectionRange`, pitch register and tonal evidence. The calculation starts at the clip's start marker, maps the initial segment into Arrangement time, then repeats its loop range. It clips stored note spans at each segment boundary, the Arrangement clip's edges and the requested window. Nonlooping clips use their markers and timeline bounds. For example, a clip spanning beats 16–28 with start marker 1 and loop 2–6 has a five-beat initial segment followed by repeats; it is not three copies of the full loop.

`projectedSegments` counts intersecting initial/loop segments. `projectedNoteOverlaps` and tonal evidence's `includedNotes` count unmuted stored note/segment overlaps, including sustained notes crossing a boundary. They are not distinct stored note IDs or triggered note-on events. `combined` sums these projected durations across eligible clips in the same requested window. Relative keys and modes can remain equally compatible; support fractions are not probabilities or a confirmed tonic.

## Keep context and exclusions visible

Muted tracks and clips remain included as stored material. Track records include current mute/solo state and, when exposed, `arrangementOverride` and `mutedViaSolo`. A Session override, group mute, routing or device can change what is heard. The tool does not model effective audibility, groove, probability, MIDI chase, device pitch transformations or rendered audio. Use [Live audio capture](live-audio-capture.md) for a separately authorized recording of the actual Resampling signal.

Current key, scale and meter are reported as current configuration, not an automation map or a detected key for the passage. Per-clip evidence and exclusions remain visible alongside the combined result. Audio, detected drums, recording clips and clips over 4096 stored MIDI notes have explicit exclusion statuses. `coverage.status: complete` means eligible requested clips were analyzed; it does not establish a key or complete audible coverage. With no overlapping clips, coverage is `empty` and combined evidence is null.

A request may scan at most 4096 Arrangement clips, overlap at most 128 clips and analyze at most 16384 stored MIDI notes. Excessive loop expansion also rejects the request. Nothing is silently sampled; choose a shorter passage or fewer tracks after a limit error. Malformed or unsupported timing fails rather than guessing an alignment.
