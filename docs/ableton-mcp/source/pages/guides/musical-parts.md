# Understand how MIDI parts relate

Use the `understand-musical-parts` prompt for a question such as “how does this bass part relate to the chords?” It starts with Set orientation, resolves the requested Session or Arrangement clips, and compares their stored pitch content without editing or starting playback. The `analyze_midi_parts` tool requires the `all` profile and the updated Remote Script.

## Choose the material

Resolve exact `trackId` and `clipId` references through `list_clips` or `list_arrangement_clips`. Supply one to eight unique references in `parts`. The displayed clip, a selected track and a track's name can identify different material. Resolve ambiguous names before analysis; do not assume every clip belongs to the section being discussed.

Each part uses its complete loop range, or its start/end markers when looping is disabled. Arrangement timeline positions are returned separately. The tool does not expand Arrangement repeats, align clips, or measure a shared playback window. For a shared Arrangement passage, use [Arrangement section analysis](arrangement-section.md) with explicit song-time boundaries. It accounts for initial offsets, loop repeats and trimmed boundaries.

## Read the evidence

One native callback reads the requested parts, their owner tracks, devices, ranges and configured scale. Each eligible part reports `pitchRange` with its lowest and highest included MIDI pitches, and `tonalEvidence` with pitch classes and duration-weighted diatonic compatibility. Muted notes and notes outside the range do not contribute; boundary-crossing notes contribute only their intersecting duration. Muted tracks and clips are included as stored material, with their mute state reported.

`combined` sums these measured durations across eligible parts. Every clip range contributes once, regardless of its length, playback status or number of Arrangement repeats. Overlapping notes each contribute their duration. Longer notes therefore contribute more than shorter notes. This is a comparison of the chosen stored material, not evidence that the parts played together.

Keep per-part results visible when discussing the combined result. A bass and a chord part may support different pitch-class groups; combining them does not resolve their musical intent. Register can help describe a part, but does not prove its role. Use the user's description and, when needed, inspect the exact notes and timing before discussing voicings or chord progressions.

Live's configured scale remains separate from measured evidence. A support fraction measures how much included note duration fits a pitch-class group; it is not a probability of a key. Relative keys and modes can fit equally, and the tool never supplies a confirmed tonic. See [Set orientation](session-orientation.md) for the shared tonal-analysis limitations.

## Check coverage

`coverage` reports requested, analyzed and excluded part counts. `complete` means every requested range was read, not that enough notes establish a key. Audio clips, detected Drum Racks, recording clips and clips with more than 4096 stored notes retain explicit statuses and have no tonal evidence. Drum detection includes nested rack chains; other instruments can still trigger unpitched samples or transform pitches.

Partial coverage leaves every excluded part visible. With no eligible parts, `combined` is null. More than 16384 analyzed notes rejects the request instead of silently sampling; choose fewer parts. Invalid, empty or mismatched clip references also reject the request.

After the discussion, continue with [instrument comparison](instrument-comparison.md) or [MIDI clip variations](midi-clip-variations.md) for an explicitly chosen part. Those workflows plan and confirm their own edits. This analysis preserves selection and focus and does not authorize playback or changes.

To write bass, melody or harmony against existing material, follow [Write a supporting part](supporting-parts.md). It establishes a shared passage before creating a separate playable part.
