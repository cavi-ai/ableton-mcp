# Understand a Set before changing it

Start with the `session-overview` prompt or call `get_session_orientation`. This read-only tool samples the Set's file, tempo, configured scale, recording state, tracks, history, selection, displayed clip and its owner's top-level devices in one Live callback. It does not change selection, start playback or edit the Set. Update and reload the packaged Remote Script before using this tool.

The displayed clip can belong to a different track from the selected track. `selection.detailClip` identifies the material being discussed; `focus.trackId` identifies its owner. An empty highlighted slot is not evidence that the displayed clip is empty. With no displayed clip, the response still reports Set context and the selected owner's devices, but has no clip evidence.

## Configuration and evidence

`musicalContext.key` is Live's configured key and scale. It may be a default or an intentional setting; it is not a detected song key.

For an eligible MIDI clip, `focus.tonalEvidence` reports unmuted pitch classes and their summed durations inside the clip loop, or the start/end markers when looping is disabled. Notes crossing the boundaries contribute only the intersecting duration. It compares that evidence with the configured scale and ranks three diatonic pitch-class groups. Each group lists the relative keys and modes sharing those notes, its duration support, and any remaining ambiguity. `tiedBestGroupCount` and `candidatesTruncated` disclose when the displayed list omits alternatives.

For example, C, D, E, F, G, A and B fit C major, A minor and several modes equally. A support fraction of 1 means every measured note duration belongs to that pitch-class group; it is not a probability that the song is in C major. This tool never supplies a confirmed key. Ask the user about the tonal center or inspect additional musical parts before choosing one.

Fewer than three distinct pitch classes yields `insufficient` evidence and no ranked groups. Audio clips, Drum Racks, recording clips, missing displayed clips and clips with more than 4096 stored notes have an explicit status and no tonal evidence. Large clips are not silently sampled. Drum detection includes instruments nested inside rack chains. Other MIDI instruments can still trigger unpitched samples or transform pitches.

The evidence describes stored notes from one clip range. It does not establish the whole Set's key, actual playback, rendered pitches, probability outcomes, groove timing, audio quality or what a listener heard. Non-diatonic scales, key changes and chromatic material require further interpretation.

For questions involving several parts, use [musical part context](musical-parts.md) to compare explicitly chosen clips together. Per-part evidence stays visible alongside combined compatibility; exclusions and the exact analyzed ranges remain explicit.

## Explore instruments together

Use the `explore-selected-instrument` prompt with a musical request such as “try warmer synths for this part.” The workflow starts with the exact clip, notes and devices, offers directions based on available instruments, and lets the user choose before changing anything.

Keep the original sound and notes while discussing candidates. A parameter snapshot cannot reconstruct a missing instrument or its opaque plug-in state. An NKS catalog entry also does not prove that Live can load that preset.

Prefer the [instrument comparison](instrument-comparison.md) workflow: create a muted native track copy, load a chosen sound only onto that copy, and switch the pair's mutes while retaining both tracks. It requires the `all` profile and stopped transport for preparation. Playback remains an explicit action, and opaque instrument state and audible results still require interpretation.

For an authorized replacement on the original track instead, establish a separate saved working Set first. `save_live_set` saves the current named Set; it cannot perform Save As. Create the working copy with Live's Save Live Set As, verify its new path, then use guarded `save_live_set` to verify the checkpoint. If that recovery path is unavailable, keep the original instrument and stop before replacement. Returning to the earlier Set can discard later edits and requires a separate user decision.

Review the exact `load_browser_item` plan and its replacement warning, then read back devices and notes. Audition only when requested or already authorized, explain the playback effect, and let the user describe what they hear. Use `stop_clip` or `transport_stop` when a stop is requested. After cancellation, failure or a manual edit, read the current state before continuing.
