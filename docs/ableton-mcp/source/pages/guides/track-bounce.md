# Print a part to editable audio

Use `print-track-to-audio` through `get_producer_workflow` in the `all` profile to keep an editable source and print a copy. The workflow duplicates one ordinary audio/MIDI track, mutes and disarms the copy, turns off its input monitoring, and uses `bounce_track_in_place` only on that copy. Refresh track IDs after duplication and verify the new copy before converting it.

## Choose the print scope

Bounce Track in Place replaces the entire target with audio in both Session and Arrangement and removes its devices. It includes device processing before mixer volume, panning and sends; those mixer settings remain on the converted track. It does not print Return/Main processing as part of the source or promise an isolated stem of everything heard. For a mix file, use [native audio export](audio-export.md).

Execution requires a saved Set, stopped playback and recording, an unarmed ordinary target, no pending launches, macOS English Live, an updated bridge, Accessibility/Automation access and one expected Live instance. The target must be visible in the current Session or Arrangement view. The tool supports one to 128 clips within the exposed-material bounds of native track preparation. External hardware and live-input monitoring need separate preparation. Preserve routing when Live refuses a render rather than changing it to force success.

Plan the existing track duplication tool first. Use a unique copy name, inspect the planned destination, and re-read the resulting inventory. Keep the source unchanged and verify the copy is muted, unarmed, not soloed and monitor-off. Compare its exposed devices, clip timing and stored notes or audio state with the source before destructive conversion. Duplication does not establish complete hidden-state or audible equivalence.

## Confirm and verify conversion

Call `bounce_track_in_place` with the copy's exact `trackId` and fresh `expectedStateVersion`. Planning sends no UI input. The confirmed plan binds native target/clip/device identities and exposed material, plus surrounding track identity, routing and mixer controls. Execution changes focus, navigates visible track headers to establish exclusive selection, checks Live's selected track and requires the singular **Bounce Track in Place** menu command. It does not invoke Bounce to New Track or a Group bounce.

`bounceVerified` requires idle UI, native audio conversion without devices, matching clip layout and mixer/output type and channel, stable surrounding tracks, and readable audio files covering the native clip source windows. It also requires replaced native target identities and new source paths; unchanged audio or reuse of existing sources cannot establish a new render. `conversionVerified`, `renderTransitionVerified` and `audioFilesVerified` expose these checks separately. They do not prove musical quality, audible equivalence, every automation/hidden state, or a saved Set. Compare the actual source and print before accepting the result.

An accepted render can continue after cancellation or a lost reply. Inspect the actual track and remaining UI before further input; never repeat an uncertain bounce, delete partial material, or use global undo automatically. Only an unchanged popup owned before the command is dismissed. Leave the print muted until playback/comparison is intended, resolve which version should sound, and preserve manual changes. Save through the separate guarded Set workflow when requested.
