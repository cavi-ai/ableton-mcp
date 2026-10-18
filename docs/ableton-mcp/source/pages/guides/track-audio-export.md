# Export individual parts

Use `export-track-stems` through `get_producer_workflow` or its MCP prompt to prepare separate WAVs for selected parts. `export_audio_track` in the `all` profile renders one exact ordinary track, Group or Return through English Live's native macOS Export Audio/Video dialog. Main uses [audio mix export](audio-export.md).

This selects the track in Live's exporter. It does not isolate audio through solo, mute, routing or device changes. Current Session overrides and mute/solo state still apply, so inspect the intended playback source first. A muted output may render silence. Stopped transport, recording off, unarmed tracks and resolved pending launches are required; these are not permission to change unrelated controls.

## Choose the output and processing

Resolve `trackId` from the current Set. The updated bridge reports native audio-output eligibility; MIDI-only tracks are not audio targets. The exporter binds the full ordered eligible-track chooser, including duplicate names, and checks the selected menu position again immediately before Export. Missing or changed entries and unknown eligibility refuse instead of choosing another output. This changes foreground focus and export preferences.

Set `includeReturnMainEffects: true` only when shared Return and Main processing is intended. The default is `false`; the track's own devices and post-fader signal remain included. Group and child exports can contain the same material. Effects-inclusive files need not sum to Main, particularly with shared or nonlinear processing. See [Ableton's render selection and effects options](https://www.ableton.com/en/manual/managing-files-and-sets/#exporting-audio-and-video).

## Keep a common range and format

Supply an absent absolute `.wav` path in an existing directory, native `start` and `length` in bars.beats.sixteenths, fresh `expectedStateVersion` and `expectedSetFingerprint`. Sample rate defaults to 48000 Hz and bit depth to 24. Supported rates are 44100, 48000, 88200 and 96000; depths are 16, 24 and 32-bit floating point. Output is stereo, with normalization, loop rendering, MP3, video and analysis-file creation off; integer output uses no dither.

For several files, agree the exact targets and new paths and use the same range and format for each. Include intended effect tails. Do not assume four beats per bar or calculate an entire render's duration from the current tempo when tempo or meter changes apply. Each render is a separate guarded confirmation; a bundle can partially succeed.

## Inspect the result

Read `trackSelectionVerified`, `renderedTarget` and `includeReturnMainEffects` separately from `exportRequested`, `uiComplete`, `artifactVerified`, `evidence` and `contextUnchanged`. The native menu check verifies the chosen output, not the contents of every note, device, envelope or hidden plug-in state. The document, observed mix controls and destination are rechecked before Export and Save. Existing files and symlinks are never overwritten.

A verified artifact is a nonempty regular WAV whose measured format, duration, file identity and SHA-256 remained stable during inspection. `renderCompletion` remains `"unconfirmed"` and `exportVerified` remains `false`: cancelled rendering can leave a valid partial file after dialogs close. Inspect the exact duration/content against independent evidence for the requested passage before accepting a full delivery. Equal settings do not establish a reconstructable mix or musical quality.

Live appends the track name to its native filename. Individual exports therefore render into a fresh private staging directory inside the destination's parent. After checking that it contains exactly one regular WAV with the requested format, the tool publishes that file to the requested path using a link that refuses an existing destination. Read `publicationVerified` separately from render completion. Successful publication removes only the owned staging entry and directory. Unknown or failed work preserves `stagingDirectory` for inspection; never treat its file as a completed final delivery or overwrite it on retry.

After interruption, inspect Live, the exact files and prior receipts. Native rendering can continue after a timeout. Preserve successful and partial artifacts, never replay the whole list or cancel unknown work, and choose a new absent path only for a separately intended retry. Unknown Save outcomes are not replayed. A changed native track choice preserves the dialog for inspection. Saving/collecting the Set and sharing files require their own scope.
