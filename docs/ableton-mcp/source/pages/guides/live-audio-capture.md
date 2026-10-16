# Capture and inspect Live audio

Use `listen-to-live-output` to inspect a short recording from Live's Resampling input. Unlike analysis of an original audio clip's source file, this records the signal Live is producing during the capture window. It does not establish what reached the speakers or what a listener heard. These tools require the `all` profile and the updated Remote Script.

## Record the current signal

Playback must already be running. Starting or changing playback requires its own authorization. Existing Arrangement or Session recording and armed tracks must be resolved explicitly before capture; the tool never disarms another track silently. It does not isolate a stem, change source routing or capture a microphone. Mix changes and performance during the window are included.

Plan `capture_live_audio` with a name and 1-16 beats, lasting 0.5-30 seconds at the observed tempo, then confirm the reviewed plan. The tool appends an audio track with mute on, solo off and monitoring off, chooses the native Resampling input, arms it and requests fixed-length recording without launch quantization. Selection may move to the new track. Following track IDs remain unchanged because insertion is at the end.

The capture track remains muted so the recorded loop cannot double the mix when recording ends. Its controls are managed until completion; changing its input, mute, arm, solo or monitoring interrupts capture. Do not edit it while it is recording or finalizing. Other tracks' controls, notes and source playback are preserved.

## Wait for recorded-file evidence

Read `get_live_audio_capture` with the returned `captureId`. A start receipt is not proof of completion. Live's main-thread bridge tick stops the bound capture clip, even if moved, and disarms its track after recording ends, including when the MCP client disconnects or stops sending requests. The bridge waits for a nonempty recorded file with stable size and modification time across consecutive ticks. The MCP server then verifies its duration with ffprobe against the requested duration, within two milliseconds or two samples, whichever is larger. Only a match is `complete`; mismatched duration is `partial`, and unavailable metadata or changed provenance is `unverified`. The response includes measured `durationEvidence`. ffprobe is required for completion verification as well as audio analysis.

The wall-clock deadline is the estimated duration at the starting tempo plus three seconds. Playback stopping, tempo changes, Arrangement recording, another track becoming armed or recording, capture-control changes or an expired deadline interrupt capture. Live may set its Session recording flag while this capture records; that flag alone is expected. The tool stops only its own recording and disarms its own track; it does not restart or stop source playback. A stop can take effect on a later Live tick. The handle remains `stopping` for at most three additional seconds while native readback is pending. Native cleanup failures are reported in `cleanupErrors`, with the handle retained for inspection and an explicit cancel retry. No successful cleanup is claimed when native readback disagrees.

## Measure and discuss

For a `complete` capture with empty `cleanupErrors` and `fileUnchanged: true`, pass the exact `file.path` to `analyze_audio_file`. Choose a window within the actual recorded duration. Loudness and true peak can describe the recorded signal; waveform and spectrum can add context. Do not use monophonic pitch inference to determine a polyphonic mix's key. Measurements do not determine preference, genre or sound quality.

Re-read the capture after analysis. Its recorded-file metadata and `fileUnchanged` must still agree before relying on those conclusions. A changed or removed file, replaced clip or resumed recording invalidates that evidence. Ask the user what they hear and use their feedback to choose the next bounded change.

## Finish, cancel and recover

`finish_live_audio_capture` releases a completed handle and preserves the track and recorded file. With `cancel: true`, it can stop an active capture early; the retained partial audio is not verified as a complete capture. If cancellation returns `captureActive: true` and `stopping`, read until the stop is confirmed, then finish the handle. Neither operation deletes recordings or saves the Set. Stop source playback separately when authorized.

After a timeout or reconnect, omit `captureId` from `get_live_audio_capture` to list existing handles before trying again. A start may have executed despite a lost reply; do not create another capture blindly. At most 16 handles are retained, so finish completed captures to release them. Runtime handles are not stored in the Set. Script reload or Live restart can invalidate them; inspect retained capture tracks and files before resuming. Bridge shutdown attempts to stop and disarm active captures and reports native failures when the handle remains available.
