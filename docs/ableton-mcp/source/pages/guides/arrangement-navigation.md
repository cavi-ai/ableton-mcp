# Navigate to an Arrangement locator

Retrieve `navigate-arrangement` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. A request such as “go back to the chorus and leave playback stopped” resolves an existing exact locator before moving the playhead. Retrieval returns instructions without changing Live.

Read `list_arrangement_cue_points` and `get_transport_recording_context`. Match the current `cuePointId`, name and `timeBeats`. IDs are current inventory indices, not persistent identities; refresh them after manual changes. Resolve duplicate names rather than choosing the first match. A locator marks a position, not a section ending, and current meter is not a historical bar map. Creating or editing locators is separate from navigating to them.

## Plan one jump

Plan `jump_to_arrangement_cue_point` with the exact ID and fresh `expectedStateVersion`. The updated bridge binds native Song, locator collection order and target identity, name/time, playback state, clip-launch quantization and loop settings. Stopped plans also bind the current playhead. Natural playback progress is excluded from playing plans. Replacements, reorders, target edits or changed transport settings refuse, including at the same state version. The bridge rechecks immediately before one native jump request.

Recording and count-in must be known inactive. The read also inspects exposed Session and Arrangement clip recording; unknown or active states refuse. Inspection supports at most 256 tracks including Groups, 4096 locators and 16384 combined Session slots and Arrangement clips. A larger Set refuses rather than sampling. Do not stop a performance, disarm a track or change quantization merely to satisfy these checks.

## Read the transport receipt

Inspect `jumpRequested`, `nativeReturned`, `targetRetained`, `playbackStatePreserved`, `arrivalMayBeQuantized`, `positionVerified`, `observed`, `error` and `observationError` separately. A returned native request is not proof that the locator was reached. With stopped playback, `positionVerified: true` requires a returned request, retained locator, unchanged stopped state and observed playhead within 0.000001 beats of the target. It does not start playback.

While playing, Live quantizes locator jumps; `positionVerified` remains false even if an immediate read happens to equal the target. The receipt reports the immediate transport observation. Read `get_transport_recording_context` independently before discussing current position, and do not blindly repeat a pending request. Native locator jump behavior is documented in the [CuePoint API](https://docs.cycling74.com/apiref/lom/cuepoint/).

A failed native call can leave the playhead moved or a jump pending. The tool reports observed partial state and never automatically retries, rolls back or uses global undo. After a lost reply, inspect actual transport and the current performance intent before planning remaining work. Unknown readback does not mean no jump occurred.

## Continue listening deliberately

Navigation preserves the current playback state and requests no track selection, loop edit, mixer/routing change or return from Session override. Session clips can keep sounding. A playhead position does not establish audible Arrangement playback or which musical part the listener hears.

Use [Arrangement audition](arrangement-audition.md) for a separately scoped loop and playback action, and [return tracks to Arrangement](arrangement-return.md) for deliberate Session-override changes. Preserve unrelated clips, recording, focus and user edits. Saving follows its own scope.
