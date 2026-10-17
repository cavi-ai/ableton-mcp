# Export a native MIDI clip

Use `export-midi-clip` through `get_producer_workflow`, or call `export_midi_clip` in the `all` profile. It exports one exact Session or Arrangement MIDI clip through Live’s native **Export MIDI Clip** command into a new `.mid` file. It supports macOS English Live and does not require saving an untitled Set first.

## Choose what the file should contain

Read the complete source notes and clip timing. Native export captures stored MIDI rather than instrument audio or MIDI-effect output. Record generated MIDI into another clip first when that performance is intended; preserve the original clip and processing.

The export can include notes outside the active loop/playback markers, omit muted notes and omit empty tails. A loop is not an export selection. Resolve a requested region separately rather than silently trim, crop, consolidate or unmute the source. Live loop, probability and velocity-deviation controls do not become equivalent SMF playback behavior.

Live currently exports SMF0 at 96 ticks per beat, so note/event timing can shift to that grid. [Ableton’s MIDI file guidance](https://help.ableton.com/hc/en-us/articles/209068169-Understanding-MIDI-files) describes the format and resolution. Instruments and their sounds are separate from MIDI files.

## Plan and export

Pass `trackId`, `clipId`, a new absolute `.mid` `path` in an existing directory, and fresh `expectedStateVersion`. The source can contain at most 4096 stored notes. Require stopped playback/recording and no pending launches. Do not stop a performance without authority.

Planning reads the source and destination without changing selection. Confirmation selects the exact source, shows its Session/Arrangement view and MIDI editor, and can hide the envelope panel. These view changes remain after export. The workflow rechecks native source identity/material, selection, Set/window, destination directory identity and filename absence before the owned Save action. It refuses overwrites and does not save the Set.

Unknown saves are never replayed, undone or deleted. Before Save, cleanup can cancel only the unchanged owned panel. Changed input, unexpected dialogs, partial files or uncertain outcomes require inspection before further input.

## Inspect the result

`exportVerified:true` requires a new verified SMF0 file, complete file coverage/end marker, unchanged exposed source state and matching unmuted note pitch/timing/velocity within the file resolution. `artifact` includes its path, byte count, SHA-256, parsed notes, event counts, beat division and final event position. Files are limited to 8 MiB. Symlinks, incomplete chunks or unfinished note durations withhold artifact verification.

Inspect `noteComparison.releaseVelocityMatch` separately. The comparison does not establish controller/MPE equivalence, MIDI-channel ownership, hidden expression, grooves, random behavior or audible equivalence. `completePerformanceEquivalenceVerified` and `audibleEquivalenceVerified` remain false. The final event position is not proof that the clip’s loop length or empty tail survived export.

For requested downstream verification, import the actual file into an authorized empty compatible destination and inspect its real notes/timing. Where Live indexes the export folder, discover the exact browser entry and use its returned path; otherwise use the receiving application’s supported import flow. Native browser MIDI loading can create another track: compare track and clip topology before/after and resolve the actual imported clip rather than assuming the selected destination received it. File creation alone is not recall or listening evidence. Keep the original and report any differences before further editing, audition, replacement, deletion or Set saving.
