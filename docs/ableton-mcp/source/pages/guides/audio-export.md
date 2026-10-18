# Export a native audio mix

Retrieve `export-audio-mix` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. `export_audio_mix` controls English Live on macOS through the native Export Audio/Video dialog. It exports Main as a new stereo WAV and requires macOS Accessibility and Automation access for the tool host.

## Prepare the range and destination

Read the current Set fingerprint, musical context, recording context and mixer. Transport must be stopped, recording off, tracks unarmed and pending launches resolved. Do not disarm unrelated tracks or change playback merely to pass this check.

Supply an absolute new `.wav` path in an existing directory. Existing files and symlinks are refused. The directory identity and absent destination are checked again before Save, and the tool never accepts an overwrite prompt.

Use native bars.beats.sixteenths coordinates: `start: "1.1.1"` begins at bar one; `length: "4.0.0"` requests four bars. Include intended effect tails in the range. Do not assume four beats per bar or convert across meter changes without evidence. Live must read back the requested coordinates exactly. A tempo change can affect duration; the output reports measured seconds rather than deriving them from one tempo value.

Main export includes current Session overrides and Main processing. Inspect those controls before exporting; returning tracks to Arrangement or changing processing needs its own requested scope. [Live's export documentation](https://www.ableton.com/en/manual/managing-files-and-sets/#exporting-audio-and-video) explains how the current Session/Arrangement playback state affects rendering.

## Confirm and render

Plan `export_audio_mix` with the path, start, length, fresh `expectedStateVersion` and `expectedSetFingerprint`. Optional `sampleRate` supports 44100, 48000, 88200 or 96000 Hz; `bitDepth` supports 16, 24 or 32 (floating point). Defaults are 48000 Hz and 24-bit. The tool requests WAV, stereo, normalization off, loop rendering off, no dither for integer PCM, and MP3, video and analysis-file output off. These choices update Live's last export preferences.

Review the warning and execute the unchanged confirmed plan. The bridge binds native document identity and observed track/Return/Main mix controls and playback references. Note, device, automation and hidden-state contents are outside that context. They can include intervening edits. The host rechecks the context before Export and Save and binds both native dialog windows, their input and the full destination directory.

The mix context includes A/B crossfader membership for ordinary tracks, Groups and Returns, their native mixer identities, and Main's crossfader parameter identity, position, availability and automation status. Changing an observed value or replacing a native mixer or Main crossfader parameter invalidates the plan even if the bridge state version is unchanged. Unavailable crossfader fields are reported explicitly. Crossfader curves and automation envelope contents remain outside this check; observed controls do not establish audible balance or complete Set equivalence.

It also binds [Stereo and Split Stereo panning](stereo-panning.md): native mode, all three pan parameter identities, values, bounds, availability and automation status for ordinary tracks, Groups, Returns and Main. It does not bind automation envelopes or device stereo processing.

Known failures before Save attempt cleanup only of unchanged owned dialogs. User edits or unavailable ownership evidence preserve the dialog and report uncertainty. A Save attempt with an unknown outcome is never replayed or cancelled automatically.

## Verify the deliverable

`artifactVerified: true` means a nonempty regular WAV matches the requested channels, sample rate and PCM format. File identity is checked before and after ffprobe and SHA-256 calculation; the result reports measured duration and `contextUnchanged` separately.

`uiComplete: true` means the native dialogs have closed. Live provides no completion receipt through this workflow, so `renderCompletion` remains `"unconfirmed"` and `exportVerified` remains `false`. A cancelled render could leave a valid partial WAV. Inspect the exact file's duration and content against the requested range before declaring delivery complete; do not derive the expected duration from one tempo reading when automation or meter changes may apply. Artifact verification establishes neither full-range completion nor musical quality, audible monitoring or equivalence of all Set contents.

The render wait is bounded at two minutes. A longer render, external-device wait, unexpected dialog, interrupted request or changed context remains unverified. Native rendering can continue after an MCP timeout or cancellation. Inspect Live and the exact destination before retrying; preserve partial files and choose a different absent path for a separately authorized retry. A pressed Save button or file alone is not completion evidence.

Analyze the exact exported file when measurements are requested, and check that its identity/hash still agrees before relying on those measurements. Export does not save the Set or collect external samples. Use [individual part export](track-audio-export.md) for chosen track, Group or Return WAVs. MP3, video, normalization and other delivery formats require separate workflows.
