# Write a supporting musical part

Use `write-supporting-part` when the request is relational: “write bass under these chords” or “add a counter-melody to the verse.” It creates a new part from the observed source passage, with deliberate musical choices and separate verification. Retrieve it through `get_producer_workflow` or its MCP prompt. Execution requires the `all` profile; retrieval does not call Live or execute work.

```json
{
  "workflow": "write-supporting-part",
  "arguments": {
    "request": "Write a sparse bass part under the verse chords, keep their timing and instruments, and audition them together.",
    "mode": "autonomous"
  }
}
```

The default `collaborative` mode proposes a register, rhythm and harmonic direction for the user to choose unless already chosen. `autonomous` makes those decisions within the brief and states them. Neither mode authorizes unrelated changes, replacement, deletion, recording or saving. Listening and further refinement follow the request's scope.

## Establish the relationship

Resolve exact source clips and the shared phrase before composing. For Arrangement material, use explicit song-beat boundaries and source tracks with `analyze_arrangement_section` and `includeHarmony: true`. Keep coverage, exclusions and per-part evidence visible. Read complete notes and timing for attacks, loop phase, offsets and sustained notes; merged harmonic intervals can hide repeated attacks. A locator does not establish its own ending, and the current meter does not establish a historical bar map.

For Session clips, read their notes/timing and `analyze_midi_parts`, then declare a common phase, phrase length and loop origin. Combined pitch evidence does not align clips or prove simultaneous harmony. Resolve incompatible lengths and offsets before building. Audio and drum exclusions do not establish silence or a chord sequence.

Chord candidates and Live's configured scale remain evidence rather than confirmed harmonic intent. Choose or clarify ambiguous interpretations. A bass root need not be the source's lowest note; a slash bass can be deliberate. Melody and counter-melody can use passing tones or tensions. State these as compositional choices. A scale fit or stored pitch match does not establish musical quality.

## Build a separate playable part

Choose explicit register, pitches, attacks, rests, durations, velocity and phrase boundaries against the observed changes. Use literal MIDI pitches when the material does not fit the configured scale. Scale/grid planners are optional when their current key, meter and degree model match the intended music; do not change global context or existing notes to fit a planner.

Create a named MIDI track, load an observed available instrument on it, and leave it unarmed with monitoring off, solo disabled and conservative levels. An existing compatible destination is also possible when explicitly chosen and its exact Session slot is empty. Re-resolve IDs after insertions. Preserve sources and existing processing.

Use `create_midi_clip` with complete notes relative to the new phrase's origin. For an Arrangement destination, retain the Session clip as staging and use `place_session_clip_in_arrangement` at the resolved song start on that same track. Translate absolute song beats into clip-relative notes: the new clip's beat zero corresponds to its chosen song start. Verify the actual placed interval, complete notes, loop and markers. A created Session clip alone does not establish an Arrangement part. See [Arrange Session ideas](session-arrangement.md) for placement limits and partial-result handling.

## Listen, refine and resume

Every mutation uses fresh observations and a reviewed unchanged plan. After interruption or an uncertain reply, inspect current owners, notes and placements before continuing; names alone do not establish completed work. Retain verified results and manual changes. If source harmony or timing changes, refresh the compositional map before further edits.

Authorized Arrangement listening uses the exact shared window and relevant source/new tracks through [Arrangement audition](arrangement-audition.md). Session listening needs an intentional phase relationship and a full-row review before a scene launch. Separate clip launches do not establish alignment. Preserve unrelated mutes, solos, arms and monitoring; other tracks may sound. Native playback or meters do not establish what the user heard.

Discuss the result, or make a bounded refinement when requested in autonomous mode. Read the current new part and edit only the intended note IDs or controls, preserving manual edits and the source. Check the shared passage again. Report choices, exclusions, actual playback and unresolved relationships. Keep staging clips and original material; cleanup and saving remain separate.
