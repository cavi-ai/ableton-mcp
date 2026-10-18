# Scale a MIDI phrase in time

Retrieve `scale-midi-phrase-time` through `get_producer_workflow`, or open its MCP prompt. Describe the part and whether it should play faster or slower within the same song tempo. The workflow supports collaborative decisions and autonomous choices within a brief.

Preserve an original for comparison with `duplicate_clip` in Session or `duplicate_arrangement_clip` at an explicitly chosen empty Arrangement interval. Read the copy's own note IDs and timing. Copies retain the track's shared processing; they are not separate instrument states.

Use `transform_midi_notes` with an explicit `scaleTime` operation:

```json
{
  "type": "scaleTime",
  "factor": 0.5,
  "originBeats": 2
}
```

This halves every chosen note's distance from clip beat 2 and its duration. A note at beat 4 lasting one beat becomes a note at beat 3 lasting half a beat. A factor of 2 produces the opposite result. Factors range from 0.25 to 4, excluding 1. The anchor must lie inside the active loop or, when looping is disabled, the marker region. Coordinates are absolute clip beats, not Arrangement song time or bar numbers.

Choose exact `noteIds`, review the dry-run changes and confirm with fresh `expectedStateVersion`, `confirmationToken` and `planHash`. IDs come from the current target; duplicated clips need fresh reads. The operation preserves IDs and exposed non-time note properties. It refuses collisions at a shared same-pitch onset, results outside playback bounds, durations below 0.000001 beat, stale identity/content/timing and unsafe recording, launch or frozen states. It does not resize a loop or Arrangement placement to fit an expanded phrase.

After applying, inspect `observed.nativeReturned`, `observed.timeScalingVerified`, `observed.error` and the separate `verification` fields. `verification.confirmed` requires a later native read matching the requested note times, all exposed note properties, native target and playback bounds. A partial write remains for inspection; a failed or unavailable readback does not authorize replay or global undo.

Scaling stored MIDI timing does not change project tempo or establish a half-time drum feel. Hidden per-note expression and clip envelopes are not retimed or verified. Assigned groove playback is not measured. Compare the preserved source and alternative with scoped playback, then use the user's feedback or the autonomous brief to choose the result.
