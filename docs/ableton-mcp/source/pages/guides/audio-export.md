# Export a native audio mix

`export_audio_mix` in the `all` profile controls English Live on macOS through the native Export Audio/Video dialog. It exports Main as a new stereo WAV and requires macOS Accessibility and Automation access for the tool host.

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

Known failures before Save attempt cleanup only of unchanged owned dialogs, including a Save panel that opens after the Export press stopped waiting for it. User edits or unavailable ownership evidence preserve the dialog and report uncertainty. A Save attempt with an unknown outcome is never replayed or cancelled automatically.

The export leaves Live where it is. It proceeds only when a Live window is already on screen, and it does not activate Live, press the Dock, or send a key. If that window is not on screen, no dialog is opened or pressed, Live is not moved and no desktop is switched; the reply reports `retrySafe: true` and `pendingUserAction: false`. A Save button that is disabled is not pressed: the export closes its own Save panel and Export Audio/Video dialog.

The File menu item, Export button, render coordinates, Save panel folder and filename, and Save button use accessibility actions. A control with no accessibility action fails before any input. The Save panel is found in Live's window list or, when that list omits it, as Live's focused window. `exportPress` reports `path` (`accessibility`), `steps` with the route of each step, `keys`, `activations`, `focus` (`before`, `activations`, `returned`, `returnedTo`) and, in `observed`, per-step evidence such as `savePanelSource` (`windows` or `focusedWindow`) and, after a timed-out wait, `afterWait` with the observed dialogs.

`retrySafe: true` means Save was never pressed, every owned dialog closed, `get_live_dialog_state` shows no dialog and the destination is still absent. Nothing was rendered, so the caller may plan the export again with a fresh `expectedStateVersion`. Any other failure reports `retrySafe: false`.

## Recover from a leftover dialog

An export refuses to start while Live shows any dialog, modal window or sheet. The reply then carries `blockingDialogs`: for each blocker its `identity`, `title`, `subrole`, `modal`, `sheet`, `sheetCount`, `buttons`, `texts`, `windowId` and, for a sheet, `parentTitle`. A failed export whose own cleanup was not verified reports the same fields.

1. Call `get_live_dialog_state`. It reads Live's blocking native windows in the background, needs no bridge and presses nothing. `identity` is `exportAudioVideo` for the Export Audio/Video dialog, `exportSavePanel` for its "Save Audio File As:" panel, `saveOutsideProject` or `saveOlderVersion` for Live's prompts after Save Live Set, and `unknown` for anything else.
2. When every blocker has a known identity, plan `cancel_live_export_dialog` with no arguments, review the listed windows, and execute the unchanged plan with its token and hash. It presses Cancel once on each window, save prompts first and then the Save panel, and reports `closed` plus the remaining `dialogs`. Live hides Export Audio/Video while its Save panel is open and shows it again after that panel closes; that dialog is cancelled too. A save prompt has no title or window id; its accessibility element binds it, and it is cancelled in the background with the Set left unsaved. No dialog needs to come from the current server process.
3. When any blocker is `unknown`, such as a save-changes sheet or a plug-in window, `cancel_live_export_dialog` refuses with `NATIVE_DIALOG_REFUSED` and every blocker's identity. It never answers a save-changes dialog; resolve that dialog in Live, then read the state again.

A changed window, sheet or identity between plan and execution invalidates the plan before Cancel is pressed. Cancel closes the dialog without rendering; plan a new export afterwards with a fresh `expectedStateVersion`.

## Verify the deliverable

`artifactVerified: true` means a nonempty regular WAV matches the requested channels, sample rate and PCM format. File identity is checked before and after ffprobe and SHA-256 calculation; the result reports measured duration and `contextUnchanged` separately.

`uiComplete: true` means the native dialogs have closed. Live provides no completion receipt through this workflow, so `renderCompletion` remains `"unconfirmed"` and `exportVerified` remains `false`. A cancelled render could leave a valid partial WAV. Inspect the exact file's duration and content against the requested range before declaring delivery complete; do not derive the expected duration from one tempo reading when automation or meter changes may apply. Artifact verification establishes neither full-range completion nor musical quality, audible monitoring or equivalence of all Set contents.

The render wait is bounded at two minutes. A longer render, external-device wait, unexpected dialog, interrupted request or changed context remains unverified. Native rendering can continue after an MCP timeout or cancellation. Inspect Live and the exact destination before retrying; preserve partial files and choose a different absent path for a separately authorized retry. A pressed Save button or file alone is not completion evidence.

Analyze the exact exported file when measurements are requested, and check that its identity/hash still agrees before relying on those measurements. Export does not save the Set or collect external samples. Use [individual part export](track-audio-export.md) for chosen track, Group or Return WAVs. MP3, video, normalization and other delivery formats require separate workflows.
