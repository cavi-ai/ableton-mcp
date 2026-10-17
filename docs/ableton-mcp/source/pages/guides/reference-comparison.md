# Compare a mix with a reference

Use `compare-mix-to-reference` when you want to understand level differences between a mix and a local reference, then choose a refinement together. Supply `request`, an absolute `referencePath` and optionally an absolute `mixPath`. The workflow and `compare_audio_reference` use the `all` profile.

## Choose the material

Choose comparable musical sections explicitly. `mixStartSeconds` and `referenceStartSeconds` are independent source-file positions. `durationSeconds` is shared, defaults to 10 and must be from 3 to 60 seconds. Both files must contain the full requested window; an overrun is refused rather than silently comparing unequal durations. The inputs must be nonempty local mono/stereo files, at most 512 MiB each. ffmpeg and ffprobe are required.

A clip's source file is not its processed Live output. For a current mix, use an existing identified render or an authorized [Live audio capture](live-audio-capture.md). Require a complete capture with matching duration evidence, unchanged file and no cleanup errors. A separately authorized [native export](audio-export.md) needs full-range completion evidence in addition to a valid WAV. Do not stop recording, isolate tracks, change playback or substitute a short capture merely to make a comparison possible.

## Read the comparison

Call `compare_audio_reference` with the exact paths, both starts and common duration. Results include each file's native identity, size, timestamps and SHA-256 before/after analysis, selected windows, integrated LUFS, true peak in dBTP and loudness range in LU. `mixMinusReference` is the mix measurement minus the reference measurement. Missing or nonfinite measurements remain `null`; silence is not treated as zero loudness.

`levelMatch` proposes constant attenuation to the quieter measured window. It never boosts either source or applies gain. It reports proposed gains and predicted true peaks separately from measured peaks, with `applied: false`. If finite loudness is unavailable, matching stays unavailable. This is a review aid, not a mastering target, headroom guarantee, file normalization, fader edit or audible A/B test.

Measurements describe decoded audio inside the selected source windows. Bounds use reported file duration; the tool does not establish musical or sample alignment, complete decoding of damaged media, whole-song dynamics, tonal balance, stereo width or musical quality. Short-window loudness range can underrepresent the complete song. Equal integrated LUFS does not imply equal perceived loudness at every moment. File identity and hashes are checked before and after measurement, not locked against later edits; retain the returned provenance and remeasure after a file changes.

## Discuss and refine

Ask what the user hears and wants to preserve. Choose one bounded change from that feedback and the measurements, then use the corresponding guarded workflow, such as [mix balance](mix-balance.md) or [instrument refinement](instrument-refinement.md). Do not infer preference or a need for compression from a loudness difference alone. Matched audition requires its own intended playback and gain scope.

After an authorized change, print the same intended passage and compare it against the same reference bytes and window. Keep earlier prints and measurements distinguishable. Re-read retained capture metadata after analysis and finish completed handles without deleting their recordings. Inspect existing handles, files and Live state after a timeout; never repeat capture or export blindly. Saving, deleting prints and delivery export each need their own scope.
