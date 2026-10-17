# Record an Arrangement take

Retrieve `record-arrangement-take` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the input, target track, empty beat range and when to start. Preparing an input does not authorize starting a recording.

## Prepare the input and passage

Use one armed, unfrozen ordinary audio or MIDI track. Playback and recording must be stopped, other tracks unarmed, pending launches resolved, and Session playback and overrides cleared across the Set. Arrangement Record can also write unarmed Session playback, so resolving only the input track is insufficient. Do not stop, disarm or return unrelated user material silently. Accompaniment for this workflow comes from Arrangement.

Read the native routing and monitoring choices. Resampling records Live's mix, not an isolated stem. A configured input does not establish incoming signal or audible monitoring. Read tempo, current meter, count-in, metronome and MIDI recording quantization. Current meter does not establish historical bar positions across meter changes.

Supply `trackId`, increasing `startBeats` and `endBeats` in quarter-note song time, and fresh `expectedStateVersion` to `record_arrangement_take`. The range must contain no existing target Arrangement clips and last at most 512 beats and 300 seconds at the observed tempo. A retake needs new empty space or an explicitly requested new track; this operation does not replace or edit a comp. Readiness supports up to 256 tracks, 16384 Session slots and 4095 existing target Arrangement clips, reserving one clip for the take.

## Confirm and record

Review the dry-run plan, announce the start and execute its unchanged confirmation when authorized. Native document, topology, routing, arms, Session state, musical controls and target clip spans are rechecked before writing. Note contents, audio-file bytes, automation and hidden device state are outside that snapshot.

The operation disables Arrangement looping, MIDI Arrangement Overdub and Automation Arm, sets the native loop bounds as the punch range, enables punch-in/out, moves the playhead and requests global recording/playback. Count-in settings are retained. Other Arrangement tracks may sound. The target remains armed and routing stays unchanged. Setup controls remain in place after stopping; restoration is a separate scoped action against fresh observations.

Retain the returned `takeId`. Native commands can apply on later ticks: `starting` and `stopping` mean a command is pending, not a failed request to replay. The bridge's main-thread tick observes accepted commands and stops owned record/playback at the punch end even without an MCP client. A start that cannot be verified becomes `start_unverified`; inspect its retained handle and Live before a fresh cancellation. Cancelling an MCP request does not cancel an accepted native recording. After a lost reply, omit `takeId` from `get_arrangement_take` to list existing handles before continuing.

## Inspect and keep the result

Read `get_arrangement_take` until the observed status resolves. `stopped` means the owned recording and transport stop were observed. `rangeCovered` compares new native clip spans with the requested interval; it does not prove captured notes, finalized audio, incoming signal, sound quality or clip provenance after manual edits. `performanceVerified` remains false. Inspect full MIDI notes/timing or audio source/timing and finalized measured file duration before judging a take. A source WAV may include material beyond the active punch clip; interpret its duration with clip markers and warp mapping rather than requiring whole-file duration to equal the passage. Preserve and report empty, silent, interrupted or short material.

For an authorized early stop, confirm `finish_arrangement_take` with `cancel: true`. Pending native stops return `released: false`; read again and release after stopping is observed. Changed document, topology, Session state, arms, routing or punch controls can lose ownership. The bridge then leaves user transport untouched. Resolve actual recording/transport state before releasing that handle. Cleanup failures retain the handle and report errors; never retry the whole recording or use global undo.

Finish a stopped handle to release runtime state while keeping its clips. At most 16 handles are retained, and a bridge restart invalidates them. The tools never disarm the target, restore setup, delete material or save the Set. Restore only preparation changes the workflow owns after comparing current values with its last applied observations. Ask what the user hears and wants to keep; separately authorized listening follows [Arrangement audition](arrangement-audition.md).

Native transport and punch properties are described in the [Live Object Model Song reference](https://docs.cycling74.com/apiref/lom/song/).
