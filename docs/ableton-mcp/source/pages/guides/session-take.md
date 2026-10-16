# Record a Session take

Retrieve `record-session-take` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the input, target part, length and when to start. Preparing or inspecting an input is separate from permission to record it. Recording one take does not authorize changing unrelated arms, monitoring, routing or material.

## Prepare the destination

Resolve an exact empty Session slot and its owning audio/MIDI track. `get_selection_context.highlightedClipSlot` can identify an empty selected slot; the detail clip or selected scene can refer to different material. Use actual input/channel choices from `get_track_routing`, and inspect MIDI routing when relevant. Resampling records Live's output. An armed track or configured input is not evidence of incoming signal or audible monitoring.

The target must be armed and unfrozen, with other tracks unarmed, recording off and pending launches resolved. Preserve existing clips. Read tempo, meter, count-in, metronome, launch quantization and MIDI recording quantization. A duration in bars must use the current meter. Announce the intended start; actual recording can be delayed by native count-in or launch quantization.

## Confirm and observe

Plan `launch_clip` with exact `trackId`, empty `clipId`, positive `recordLengthBeats` in quarter notes, optional one-shot `launchQuantization`, and fresh `expectedStateVersion`. Review the `beforeRecording` input/readiness context and warning, then execute with its confirmation token and plan hash. The updated bridge rechecks native document/track/slot identity, selected routing and monitoring, MIDI routing, arms, playback references, recording modes and musical controls before firing. It supports at most 256 tracks and 16384 Session slots. Device processing and all accompaniment notes are outside the bound context.

The request can start global playback, replace the target's earlier Session playback and leave the take playing or looping afterward. It does not change arms. `recordingRequested: true` with `recordingVerified: false` is an acceptance receipt, not proof of a completed take. Native fixed-length recording continues independently of the MCP request; cancelling that request does not undo a started take.

Launching an empty armed slot without `recordLengthBeats` starts open-ended recording with the same readiness guard. Its plan explicitly warns that a scoped stop is required to finish the take. Prefer a fixed length when the intended duration is known.

Group-slot launches require all tracks to be unarmed because Live can record armed children according to its launch preference. Record into an individual Session slot instead; do not disarm unrelated tracks merely to pass this check.

Read `list_clips` for actual `isTriggered` and `isRecording` state. After recording ends, inspect complete MIDI notes and timing, or the audio source and its finalized measured duration. Compare the observed length with the request in the correct units. A length mismatch is a partial take: report its actual length and preserve it; never pad, crop or extend it silently. Use an authorized beat/bar launch grid for a musically aligned start, while respecting an explicitly immediate start and checking its actual result. A created clip, empty MIDI take or silent recording does not prove a successful performance or audible monitoring. Keep partial material after interruption. If a reply was lost or material may have been replaced, report identity uncertainty and inspect before proceeding; never retry a recording blindly.

## Keep, stop or try again

For an early stop, use a scoped `stop_clip` and verify recording stopped. Stop global transport only when intended. A retake needs a different verified empty slot and a fresh plan; keep the earlier take. Preserve manual edits and original arm/monitoring states. Restore only preparation changes this workflow owns after comparing fresh context with its last applied observations. Quantizing, cropping, processing, deleting and saving each require their own scope. Finish by reporting the recorded material, actual playback and remaining armed state.
