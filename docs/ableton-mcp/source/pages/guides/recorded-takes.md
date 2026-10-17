# Inspect recorded takes

Retrieve `inspect-recorded-takes` through `get_producer_workflow` or its MCP prompt. Describe the track, passage and musical question. The workflow reads stored performances alongside the main Arrangement without changing the comp, focus or playback.

## Find alternate performances

`get_take_lane_context` with `trackId` lists take lanes and their clips alongside that track's main Arrangement. Supply a returned `takeClipId` to read one take's complete stored MIDI notes or exposed audio source, gain, pitch, warp and timing controls.

IDs describe the current inventory and must be resolved again after insertions or manual edits. They cannot be passed to ordinary clip tools. A matching name or interval does not establish that a main-lane clip is the selected take.

Inspection supports up to 128 lanes, 4096 take clips, 4096 main Arrangement clips, and 4096 notes or warp markers in the selected take. Exceeding a limit fails rather than sampling. Missing native support is reported with `supported: false`; it is not an empty take history. Group, Return and Main tracks are outside this scope.

## Interpret stored material

Arrangement spans use quarter-note song beats. Local clip markers use beats for MIDI/warped audio and seconds for unwarped audio. Complete MIDI notes include stored material outside active markers; account for markers and loops before interpreting the performed passage.

Audio takes can share a source file containing multiple passes. File analysis measures an explicit source-time window and does not automatically isolate the selected take. Do not convert warped beat markers to source seconds using current tempo or rank performances from full-file loudness.

Stored takes do not reveal current comp selections, source highlights or lane audition state. Notes and exposed source settings are evidence of stored material, not a musical ranking or audible outcome. Audio-file bytes, envelopes, expression, effective routing and rendered sound are outside the snapshot. Ask what the user hears and wants to keep.

## Respect the action boundary

`takePromotionSupported` is false. The native Arrangement duplication operation can copy the main comp over the take's interval instead of copying that take's content. This tool provides no copy, promotion, audition, recording, deletion or comp-editing action. Never substitute a similar main-lane clip or claim a take was promoted from an inspection result.

Existing [Arrangement analysis](arrangement-section.md) and [audition](arrangement-audition.md) operate on the main Arrangement, not hidden takes. Separately authorized work on normal clips can continue through those workflows while keeping the distinction explicit.

Take-lane structure is documented in the [Live Object Model reference](https://docs.cycling74.com/apiref/lom/takelane/); [Live's comping manual](https://www.ableton.com/en/live-manual/12/comping/) describes the native UI operations.
