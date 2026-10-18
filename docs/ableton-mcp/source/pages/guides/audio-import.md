# Bring audio into a song

Retrieve `import-audio-file` through `get_producer_workflow` or its MCP prompt in the `all` profile. Describe the exact local file, intended part/track, Session slot or timeline position, timing intent and any audition request. Collaborative mode resolves meaningful choices with the user; autonomous mode chooses within the brief. Playback, replacement, deletion and saving retain their own scope.

## Import directly into Arrangement

`create_arrangement_audio_clip` takes `trackId`, `startBeats`, absolute `sourcePath`, explicit `name` and fresh `expectedStateVersion`. The ordinary audio track must have an entirely empty Arrangement. Its Session clips and processing remain in place. Append a new audio track only within the requested scope; do not delete or move existing material to satisfy the empty-track requirement.

Live determines the native span and warp state during import, so the tool does not guess an end position or risk overwriting a populated timeline. The start must be within 0 to 1576800 quarter-note beats. Names must be nonempty, at most 128 characters and contain no control characters. Target lookup supports up to 256 tracks.

The plan binds native track ownership and the empty timeline, plus the canonical source path, size, modification time, device and inode. It rechecks the target and file metadata at undo entry and verifies the new audio object, source reference and interval before naming. Frozen/non-audio tracks, recording/count-in, stale targets or populated timelines refuse. Live validates the file format. File bytes, an atomic file read by Live and its decoded cache are not bound.

Inspect `importRequested`, `nativeReturned`, `nameWriteReturned`, `importVerified`, `targetRetained`, `sourceMetadataUnchanged`, `sourceReferenceMatched`, `createdClipId`, `observedClip`, `audioState`, `observedTiming`, `clips` and errors independently. Import or finalization failures retain partial work without rollback or replay. A failed native call or lost reply may leave a clip with unconfirmed ownership; inspect the current track before continuing. Never delete an ambiguous candidate or globally undo over manual edits. A changed native source reference remains unverified.

Read the actual source, gain, pitch, warping, markers, loop and timeline span again after import analysis before planning further edits. An imported file is not a collected-media backup or a rendered stem with track effects. Preserve the source bytes. Natural recorded timing or a specific musical length needs explicit intent and separately guarded edits of the owned clip, followed by actual timing readback; do not silently enable warping, crop or claim a requested length was achieved.

## Session and populated Arrangement tracks

Use `create_audio_clip` for an observed empty Session slot on a compatible track, then inspect `get_audio_clip_state` and `get_clip_timing`. Its native import guard binds the source file metadata; do not treat a matching name as proof of current clip ownership after an interruption.

For a populated Arrangement track, an explicitly scoped empty Session staging slot on that same track can retain the imported source. A warped clip can then use `place_session_clip_in_arrangement` with its full observed length at a verified nonoverlapping interval. Every step has a separate fresh plan and readback. Unwarped placement on populated tracks remains unsupported because the tempo map can affect duration. Resolve the timing or destination choice; do not enable warping merely to bypass a refusal or silently substitute a track. Keep staging clips unless cleanup was requested and exact current ownership/content can be established.

Authorized timeline listening follows [Arrangement audition](arrangement-audition.md). Session listening uses a scoped clip launch and actual playback readback. Other tracks may sound. Native meters or requested [audio capture](live-audio-capture.md) can provide evidence of signal; they do not establish what the user heard. Discuss the result and refine the imported part through [audio clip development](audio-clip-development.md), preserving manual edits and existing processing.
