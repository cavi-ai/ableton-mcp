# Diagnose a silent part

Use `diagnose-silent-part` through the MCP prompt or `get_producer_workflow`. Describe the exact part and what should be sounding. The workflow starts with observation and proposes a remedy from the evidence; retrieving it does not call Live or change controls.

## Read actual activity

`get_track_signal_activity` requires the `all` profile and the updated Remote Script. Supply an observed `track-N`, `return-N`, or `master` ID. Each call reads native input/output peak-hold meters and current transport, mute, solo, arm, monitoring and Session playback flags in one Live callback. Unsupported control fields remain `null`.

Production specialists can discover this read schema through `discover_production_tools` before requesting it on a later turn. Ollama read requests and checks use the schemas supplied for the current turn, alongside bounded discovery and artifact reads. Creative specialists can discover reads only; the coordinator independently validates either runtime's requests. Discovery grants no operation authority and does not execute the diagnostic workflow automatically.

```json
{ "trackId": "track-2" }
```

Each meter has `status: "available"`, `"unavailable"` or `"invalid"` and a `value`. A valid zero stays zero; unavailable, nonnumeric, nonfinite or out-of-range readings have a null value and an explicit status. Nothing is clamped or replaced with assumed silence. The tool does not start playback, move selection, change controls, add meter listeners or wait for a sampling window.

`transport.currentSongTimeBeats` is Live's song position in quarter-note beats, not seconds or a meter-sampling timestamp. The `stateVersion` identifies bridge state; it is not an audio sample counter or proof that a previous reading is still current.

Native meter values span 0–1 and hold the recent peak for one second. They are not linear amplitude measurements to convert to dB, loudness readings, clip indicators or proof of sustained silence. A fresh zero may miss an intermittent part, while a nonzero value can reflect an earlier event or tail. MIDI activity does not establish audio generation. Separate calls for a track, bus and Main are not sample-synchronous; other parts can contribute to bus and Main readings. See the [Track meter reference](https://docs.cycling74.com/apiref/lom/track/).

## Trace the expected source

Use current playback and recording context before interpreting meters. Inspect the exact Session clip or Arrangement passage, Session overrides, actual instrument/device hierarchy, track and parent Group mutes/solos, native fader displays, input monitoring and observed routing destinations. For monitoring, 0 is In, 1 Auto and 2 Off. Return/Main controls are available through `get_set_mixer`. An external MIDI destination, Sends Only route or inactive device may be intentional; do not replace it with a generic routing recipe.

Diagnosis does not authorize playback, isolation, arming, monitoring, gain or routing changes. Preserve the performance and manual edits. If a remedy is requested or already authorized, use the original guarded mutation, inspect its exact result and take a fresh snapshot during the intended source. Ask what the user hears. Meter activity and changed controls do not establish sound at the speakers; separately requested recordings follow [Live audio capture](live-audio-capture.md).
