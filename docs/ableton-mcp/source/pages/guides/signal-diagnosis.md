# Diagnose a silent part

Use `diagnose-silent-part` through the MCP prompt or `get_producer_workflow`. Describe the exact part and what should be sounding. The workflow starts with observation and proposes a remedy from the evidence; retrieving it does not call Live or change controls.

## Read actual activity

`get_track_signal_activity` requires the `all` profile and the updated Remote Script. Supply one observed `trackId`, or a `trackIds` list of 1–64 unique ordinary track, Group, Return or Main IDs. Each call reads native input/output peak-hold meters and current transport, mute, solo, arm, monitoring and Session playback flags in one Live callback. Unsupported control fields remain `null`.

Production specialists can discover this read schema through `discover_production_tools` before requesting it on a later turn. Ollama read requests and checks use the schemas supplied for the current turn, alongside bounded discovery and artifact reads. Creative specialists can discover reads only; the coordinator independently validates either runtime's requests. Discovery grants no operation authority and does not execute the diagnostic workflow automatically.

```json
{ "trackId": "track-2" }
```

For a resolved signal path, request only the relevant part, parent Groups, Return buses and Main together:

```json
{ "trackIds": ["track-2", "track-0", "return-0", "master"] }
```

Batch results contain ordered `tracks` records and one shared `transport`, `stateVersion` and `meterSemantics`. Single-track results retain their existing shape. Choose exactly one selector. Invalid, duplicate, missing or oversized targets refuse the entire request before meter reads; the tool never guesses a route or substitutes the selected track. Resolve actual routing and Group membership first.

Each meter has `status: "available"`, `"unavailable"` or `"invalid"` and a `value`. A valid zero stays zero; unavailable, nonnumeric, nonfinite or out-of-range readings have a null value and an explicit status. Nothing is clamped or replaced with assumed silence. The tool does not start playback, move selection, change controls, add meter listeners or wait for a sampling window.

`transport.currentSongTimeBeats` is Live's song position in quarter-note beats, not seconds or a meter-sampling timestamp. The `stateVersion` identifies bridge state; it is not an audio sample counter or proof that a previous reading is still current.

Native meter values span 0–1 and hold the recent peak for one second. They are not linear amplitude measurements to convert to dB, loudness readings, clip indicators or proof of sustained silence. A fresh zero may miss an intermittent part, while a nonzero value can reflect an earlier event or tail. MIDI activity does not establish audio generation. A batch shares one native callback and transport observation, but its meter properties are read sequentially and are not sample-synchronous. Other parts can contribute to bus and Main readings. See the [Track meter reference](https://docs.cycling74.com/apiref/lom/track/).

## Trace the expected source

Use current playback and recording context before interpreting meters. Inspect the exact Session clip or Arrangement passage, Session overrides, actual instrument/device hierarchy, track and parent Group mutes/solos, native fader displays, input monitoring and observed routing destinations. For monitoring, 0 is In, 1 Auto and 2 Off. Return/Main controls are available through `get_set_mixer`. An external MIDI destination, Sends Only route or inactive device may be intentional; do not replace it with a generic routing recipe.

Diagnosis does not authorize playback, isolation, arming, monitoring, gain or routing changes. Preserve the performance and manual edits. If a remedy is requested or already authorized, use the original guarded mutation, inspect its exact result and take a fresh snapshot during the intended source. Ask what the user hears. Meter activity and changed controls do not establish sound at the speakers; separately requested recordings follow [Live audio capture](live-audio-capture.md).

## Apply an authorized mixer remedy

Use `set_track_mixer` for one ordinary or Group track and `set_bulk_track_mixer` for up to 64 exact tracks in one confirmed request. Existing volume, Stereo pan, mute, solo and single-track send combinations remain available. Native track, mixer, control and Return ownership, selected audio paths, arms and all explicit track/Return mute/solo states bind the plan. Playback may continue; recording, count-in and pending launches must be known inactive. Automatable requested controls require native enabled state and known inactive automation. Mute checks the Track Activator parameter. Frozen status alone does not refuse an otherwise writable mixer control. Single-pan edits require Stereo mode; use the mode-aware panning workflow for Split Stereo.

Inspect `verified`, `requestedChangesVerified`, `targetRetained`, `contextPreserved`, `writes`, `nativeReturned` and `observedContext`. Matching controls do not prove isolation or what the user heard. Native solo assignment keeps existing solos; inspect all relevant tracks and Returns instead of unsoloing them silently. Requested mutes are applied before other preparation, and requested unmutes afterward. A no-op sends no setter and opens no undo step. One undo group does not make the writes atomic. A failure can leave earlier controls changed; the receipt retains each attempted write without rollback or replay. After a lost reply, read current mixers before planning remaining work. Continuous native readback accepts only rounding within 0.000001 of the requested raw value; use the dB tools for native gain targets.

For temporary audition, retain the prior and last applied controls. Restore only owned values that still match the last applied observations, preserving manual edits and unrelated solos. Group controls affect routed descendants. Stopping playback, changing monitoring or arms, rerouting and saving remain separately scoped.
