# Build a sample instrument

Retrieve `build-sample-instrument` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the musical role, a local sample or configured library, the intended part and any audition request. `collaborative` resolves material choices with the user; `autonomous` chooses within the brief. Retrieving the workflow does not execute it.

## Preserve a playable part

For an existing MIDI part, use [instrument comparison](instrument-comparison.md) to retain the original and load a different sample into the resolved alternative. Re-read both actual device paths after duplication. Parameter snapshots do not capture full sample state. If comparison is unavailable, resolve whether a separate staging track or an explicitly authorized replacement is intended.

For a new part, create the intended MIDI track and load Simpler from an observed factory browser path. Inspect the actual device chain. Search configured local samples or use an explicit existing file; a browser URI or filename alone is insufficient to identify that file. Source analysis can inform pitch, duration or transients, but does not establish the loaded instrument's sound.

## Inspect and load Simpler

`get_simpler_sample_state` reads one exact existing Simpler on an ordinary MIDI track, including a device inside a rack chain. It reports the sample path, length, start/end markers, slices, sample rate, gain, warp state, playback mode, parameters and native context without moving selection. Empty Simpler reports `sample: null`. Sampler and Simpler multisample replacement are outside this operation.

Length, start/end markers and slices use **sample frames**. Divide a position by the observed sample rate in Hz to obtain source seconds. These are not clip beats, MIDI notes or an Arrangement location. Unavailable slice/rate fields remain `null`.

The context also binds exposed native warp markers and slicing/timbre controls, including the shadow warp marker. Warp-marker `sampleTime` is retained in its native representation and marked `sampleTimeUnit: "native-unverified"`; do not treat it as frames or seconds. These collections are bounded at 4096 entries, and unavailable optional controls remain `null`.

Plan `load_simpler_sample` with exact `trackId`, `deviceId`, absolute `sourcePath` and fresh `expectedStateVersion`. Optional `playbackMode` selects `classic`, `one-shot` or `slicing`; omitting it leaves the resulting mode to Live. `allowReplace` defaults to `false` and must explicitly be `true` for a loaded sample.

The confirmed plan binds native document, owner, device, sample and parameter identities and exposed controls, plus the chosen file's size, modification time, device and inode. Execution rechecks these before invoking Live's [native sample replacement](https://docs.cycling74.com/apiref/lom/simplerdevice/). It requires stopped transport, recording off, an unfrozen unarmed target, no input monitoring, pending target launch or active sample playback. The target must expose native replacement and be in single-sample mode. Native loading validates the audio format.

Readback verifies the exposed path, positive frame length/rate, valid marker bounds and requested playback mode. Live may rename the device after loading; retain native IDs and re-read its actual name. Readback does not prove decoded file bytes, Live's cache identity, audible equivalence or hidden state. Replacement may reset sample-derived controls, markers, slices or warping. There is no complete sample-state backup or automatic rollback; an error after invocation can leave a partial replacement. Inspect the device and file before retrying, preserve intervening work and avoid global undo.

## Play and refine

Independently read the sample state after loading and compare the retained original's sample, parameters and notes. Use existing guarded parameter tools only for intended exposed controls. A playback mode alone does not establish correct note-to-pitch or slice mapping; resolve those against observed material before writing a new clip.

To isolate a hit or phrase, plan `set_simpler_sample_region` with exact `trackId`, `deviceId`, fresh `expectedStateVersion`, and `startMarkerFrames` and/or `endMarkerFrames`. At least one bound must change; omitted bounds retain their observed values. Both must be integer source frames satisfying `0 <= start < end < lengthFrames`. Convert source seconds using the observed sample rate and make the rounding choice explicit. Clip beats and normalized device parameters are not source frames. If the correct sample is already loaded, keep it; a region edit does not require sample replacement.

The region tool supports nested rack devices and binds the native sample, owner, parameters and complete exposed context. It requires the same stopped, inactive, unarmed single-sample target as loading. It moves the expanding edge first for disjoint regions, rechecks ownership after each marker assignment, and verifies the exact requested markers and retained source properties. It edits [native playback markers](https://docs.cycling74.com/apiref/lom/sample/) without cropping or writing the source file. Live may derive playable slices and normalized sample/loop controls from the bounds; inspect those after each edit rather than promising preservation of their former values. Slice insertion/removal, warp editing, and complete hidden-state backup are outside this operation.

A failed marker assignment or readback can leave a partial region. No automatic rollback is attempted. Read the actual target before retrying; do not reload the file, replay stale bounds or use global undo to discard intervening work. A deliberate return to earlier markers needs a fresh plan after comparing current state with the last applied observations. Audition the chosen region and compare the preserved original; exact marker readback alone does not establish a good edit or a click-free boundary.

Audition only when requested or already authorized. Native comparison switches only the pair's mutes; preserve unrelated tracks and read actual playback after quantization. Other material can sound during global playback. Ask what the user hears; a file path and MIDI playback are not proof of audible output or musical quality. Separately requested measurements follow [Live audio capture](live-audio-capture.md).

Keep the original and chosen alternative. Saving, collecting external samples, deleting alternatives and further edits retain their own scope. Loaded samples remain external references; replacing one does not create a portable Project or independent audio backup.
