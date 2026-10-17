# Build instrument layers

Ask for a direction such as “Keep this bass part and build sub, body and texture alternatives into a shared bus.” Retrieve `build-layered-instrument` through MCP prompts or `get_producer_workflow`, with the request and optional `mode: "collaborative"` or `"autonomous"`. Autonomous choices stay within the brief; playback, replacement, saving and deletion retain their own scope.

## Preserve the part

Resolve the exact requested track, clip and location before using selection as a fallback. Read complete MIDI notes, timing, source devices, mixer and routing. For Session material, append new ordinary MIDI tracks and copy the source with `duplicate_clip` into verified empty slots. Keep the original instrument and track intact. Re-read each copy's note IDs, and compare its stored notes and timing while allowing newly assigned IDs.

An Arrangement passage cannot be copied directly onto a different track with these tools. Track duplication through `duplicate_session_object` copies all Session and Arrangement material and devices, and shifts later IDs. Use it only with explicit full-track scope, then re-resolve every reference and replace devices only on the owned alternative. Report that boundary when the user wants only one passage; do not silently duplicate the entire track.

## Build a shared audio bus

Choose actual available instruments and meaningful roles using a layered producer blueprint as a starting point. Blank Sampler, Drum Sampler and Drum Rack devices need sample or pad content; a device name alone does not establish an audible instrument. Source-specific sound choices, optional effects and register changes require the requested musical scope.

Create a uniquely named ordinary audio track for the bus. Read `get_track_routing` and set its observed **No Input**, monitoring **In**, and **Main** output choices. Append role tracks, keep owned layers unarmed with monitoring off and solo disabled, and prepare conservative native dB levels. Load instruments and bus effects onto these new tracks, checking each load plan and observed device order. Keep existing tracks, Return processing and sends intact.

For each layer, match exactly one observed output type to the unique bus name, set that actual `outputTypeId`, then re-read routing to resolve its **Track In** `outputChannelId`. Names may be routing IDs; track indices are not substitutes. Never route the bus back into a layer or upstream source.

This serial audio bus is distinct from a Group Track and a Return. `route_tracks_to_bus` requires an existing Group Track; use `set_track_routing` for ordinary audio buses. Native Group creation is outside these tools. Returns use a separate sends workflow.

## Inspect the configuration

For a complete layered blueprint, call `inspect_producer_bus` with `busKind: "audio"`, exact `target`, `busTrackId`, and one distinct child track for every blueprint role. Omitted `busKind` retains the existing Group inspector. Audio inspection requires an ordinary audio owner and checks native factory class identities, optional selected plug-in profiles, prescribed bus-effect order, source types, direct child routes and Track In channels, plus bus No Input, monitoring In and Main output.

The reader performs two sequential passes of native track snapshots and compares them, followed by a topology check. Changed observations fail, including exposed manual edits that do not advance the bridge version. A matching result reports `consistency: "matching_two_pass_reads"`; it is not an atomic multi-track snapshot or continuous identity lease. Matching names and equal state versions alone do not prove unchanged native objects.

Require `matchesBlueprint: true` only when the full prescribed configuration was intended. Custom or partial recipes can be useful: inspect their actual devices and routes and report deviations rather than claiming a full match. Mute, solo and arm observations remain separate. Inspection does not establish loaded sample content, clips, automation, hidden plug-in state, sends, downstream processing, phase alignment, headroom or sound quality.

## Audition and refine

Added layers sum with the original. Muting the original or unrelated tracks for comparison requires that scope. Launch Session clips only when playback is authorized; separately launched clips are not proven phase aligned. A shared scene launch needs the full row checked, including unrelated slots, stop buttons, armed recording risks and tempo/meter overrides. Arrangement playback follows [passage audition](arrangement-audition.md).

Check actual playback and ask what the user hears. A separately authorized [audio capture](live-audio-capture.md) measures the current Resampling mix and may include other tracks. Re-read before refinements and preserve manual edits. After interruption, inspect actual tracks, copies, devices and routes before continuing missing steps; do not rebuild blindly or use global undo. Keep originals and chosen alternatives, and save or delete only within the requested scope.
