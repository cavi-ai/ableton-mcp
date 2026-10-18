# Overdub a Session MIDI loop

Retrieve `overdub-session-midi` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Use this when a user wants to play additional notes into an existing loop and keep listening afterward. For a fixed-length take into an empty slot, use [Record a Session take](session-take.md).

## Preserve and prepare

Resolve the exact Session MIDI clip, complete notes, timing and instrument. By default, use `duplicate_clip` into a verified empty slot, name the alternative and independently verify its notes/timing. In-place recording needs explicit scope. Native same-pitch recording can alter or replace notes in the working clip; preserving its baseline events is not guaranteed. Hidden per-note expression is not exposed or reconstructed.

Prepare the requested input/channel, monitoring and arm state using actual routing choices. Other explicit and implicit arms must be off. Do not disarm unrelated tracks to make a check pass. Launch the copied loop under playback authority with recording off, and let pending launches settle. Preparing an input does not itself authorize recording; configured routing and meters do not prove a performance or audible monitoring.

## Start and stop interactively

`get_session_midi_overdub_context` reads the exact already playing loop without changing focus. It requires an armed unfrozen MIDI target, playing transport, no pending launches/stops, Arrangement recording/count-in off and automation recording arm off. It supports up to 256 tracks, 16384 Session slots and 16384 baseline notes. The context binds native target identity, topology, arms, input routing/monitoring, timing, tempo, meter, MIDI recording quantization and the initial note digest. It does not bind accompaniment content or device processing.

Plan `set_session_midi_overdub` with exact `trackId`, `clipId`, `enabled: true` and fresh `expectedStateVersion`, then confirm the unchanged plan. Native execution checks the context again at undo entry and assigns only `song.session_record`, the Session Overdub switch. Live's legacy `overdub` readback can follow this switch; Arrangement overdub remains separate. The tool leaves arms, routing and transport unchanged.

Recording starts now and remains open-ended. There is no scheduled musical boundary, fixed duration, automatic stop or disconnect cleanup. State this before starting; use an explicit start/stop cue. This helper does not promise an exact number of passes. On the stop cue, read fresh context and confirm the same tool with `enabled: false`. Incoming notes and advancing song time do not invalidate stop confirmation. The loop and transport remain playing; the target remains armed.

Read `nativeReturned`, `sessionRecordVerified`, `scopeVerified`, `scopeError`, `overdubActiveObserved`, `recordingStoppedObserved`, `requiresInspection`, `error` and `observationError` separately. Post-dispatch scope changes or undo-finalization errors remain inspection-required even when the recording switch changed successfully. They do not trigger automatic rollback over other work. `performanceVerified` remains false: a recording switch or clip flag is not proof that any notes were received. Clip state can settle after the request; inspect fresh context and complete notes before reporting completion.

## Continue after interruption

After a lost reply or disconnect, inspect the current recording modes and exact target; never replay a start. There is no runtime handle or saved ownership record. A fresh explicit stop can use the observed target after reconnect. If arms, playback, target identity or recording scope changed, inspect and resolve the new stop scope. A scoped `stop_clip` or separately authorized global recording/transport stop may be needed if this helper's prerequisites no longer hold. Do not force a stale confirmation or stop unrelated recording.

Compare complete final notes and timing against the working baseline and verify the preserved original separately. Report actual additions, alterations, removals and empty/partial performances. Retain partial material and manual edits. Ask what the user hears before judging musical improvement. Retakes use another preserved copy. Quantization, deleting, saving and stopping playback retain their own scope. Restore only preparation changes still owned by this workflow after comparing fresh state, and report remaining arms/monitoring.
