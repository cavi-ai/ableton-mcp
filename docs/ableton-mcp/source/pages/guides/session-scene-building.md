# Build a Session scene from chosen parts

Retrieve `build-session-scene` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe a section and its parts, for example “make a new verse scene from the named chords and vocal clips; keep the originals and leave playback stopped.” The default `collaborative` mode proposes unresolved combinations. `autonomous` chooses parts within the brief. Existing choices and authorization are reused.

## Map the parts

Resolve one exact Session clip per ordinary track. Read complete MIDI notes/timing or audio state and timing. A row cannot play two clips on the same track together. Different loop lengths can form a repeating combination; the workflow preserves them rather than rewriting sources to fit. Copies use existing track devices and mixer settings. Individual source-scene tempo/meter overrides do not follow the clips.

For a requested current combination, resolve actual playing clips. Copying stored material does not capture playback phase, rendered audio or an uncaptured performance. Recording, frozen material and pending launches need resolution within the intended scope.

## Assemble and resume

Append a named scene with `create_scene`, then resolve each track's actual empty slot in the new row. Copy sources on their own tracks with `duplicate_clip`, fresh guards and unchanged confirmations. Require `copyVerified` and independently compare complete notes, musical timing and exposed audio state as applicable. Native verification is immediate; Live can adjust the copied editor grid afterward. Inspect that view setting separately when it matters. Source clips and existing scenes stay in place. Audio copies share source files; hidden state, envelope contents and external file bytes are outside copy verification.

Scene creation and copies are separate operations. After interruption, inspect the identified partial scene and verify completed copies before planning missing entries. A name alone does not establish ownership or completion. Preserve ambiguous content and partial work; never append another scene or replay the whole map to make a retry easier.

## Configure requested launch behavior

Read `get_clip_timing` for each exact copied Session clip. Its `launchMode` reports native `trigger`, `gate`, `toggle` and `repeat` choices when supported. Change a requested mode with `set_clip_timing`, for example `launchMode: "toggle"`; numeric choices also use the observed native value. Preserve existing quantization, Legato, loop settings and source clips unless the brief requests their change.

Launch-mode edits require an updated bridge, stopped playback, recording off, an unfrozen track and no pending target launches. The plan binds the native track, slot and clip; replacing a clip with identical settings invalidates it. Arrangement clips and unavailable native modes report `supported: false`. Configuration changes no playback or focus.

Gate and Repeat rely on held-button input. The current `launch_clip` tool sends a one-shot fire request, so it does not provide a sustained press. Configure these modes for the intended controller interaction; do not infer a held performance from configuration or from launching a scene. Mode names and held-button behavior follow the [Live Clip API](https://docs.cycling74.com/apiref/lom/clip/).

## Preview before listening

`get_scene_launch_context` reads the entire row in one native callback without moving selection or launching. It reports every track's target slot, current playback, arm/monitoring, mute/solo, Group membership and scene/global musical controls. `rowSummary` groups clip launches, empty stop/continue slots, Groups, armed empties, native `willRecordOnStart` and already-recording tracks. Unknown raw fields remain unknown; the summary is not a safety verdict.

An empty stop slot can stop unrelated Session playback. Groups can affect descendants. Armed empties may record under a Live preference that is not exposed, and scene tempo/meter overrides affect the whole Set. The preview does not inspect complete notes, devices, follow actions or audible output. Review the full row, including tracks outside the chosen source map.

When the intended section explicitly keeps another part playing, use [empty-slot stop buttons](session-stop-buttons.md) to configure only those resolved ordinary slots. Each edit needs its own fresh guarded plan and readback. Preserve all other row settings and read the entire row again before auditioning. Removing a stop button does not prove that armed empties cannot record.

Audition follows [Session scene playback](scene-launch.md) only when requested or already authorized. It uses a fresh guarded launch plan and actual playback/recording readback after quantization. Building or previewing a scene does not launch it, alter stop buttons or authorize unrelated control changes. Keep the original clips and chosen scene; saving and deleting partial work have their own scope.
