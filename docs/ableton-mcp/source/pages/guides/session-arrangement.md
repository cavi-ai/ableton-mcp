# Arrange Session ideas into sections

To capture actual user or agent clip/scene launches instead of building a fixed section map, use [Record a Session performance](session-performance-recording.md).

Retrieve `arrange-session-ideas` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the Session parts, intended structure and whether playback or saving is wanted.

```json
{
  "workflow": "arrange-session-ideas",
  "arguments": {
    "request": "Arrange the named chords and bass into an intro and verse in empty timeline space. Keep the Session clips and leave playback stopped.",
    "mode": "autonomous"
  }
}
```

The default `collaborative` mode proposes a section map for the user to choose. `autonomous` lets the agent choose section order, repetitions and entrances within the brief. Neither mode authorizes unrelated edits, deletion, playback, recording or saving. Retrieving instructions does not execute the workflow.

## Map the parts before copying

Resolve exact Session track and clip references, then read their notes, timing and actual lengths. Scene follow-actions, tempo/meter overrides and launch behavior do not become an Arrangement structure automatically. Use zero-based quarter-note song times. The current meter does not establish historical bar positions across meter changes.

Each `place_session_clip_in_arrangement` call copies one native playback span onto its own track. For a looped source, the span is one full loop plus any lead-in between the start marker and loop start. A six-beat loop from clip beat 2 to 8 with its start marker at 0 therefore occupies eight Arrangement beats. An entry inside the loop adds no lead-in. A nonlooped source uses the distance between its start and end markers.

The dry-run plan's `placement` reports `lengthBeats`, `loopLengthBeats`, `leadInBeats` and the calculation basis. Use that span for the section map and each adjacent placement; `list_clips.lengthBeats` alone reports loop length for a looped clip. Repetition also repeats any lead-in, so resolve the intended pickup before building repeats. Preflight the entire proposed map against existing Arrangement clips and other entries. Resolve incompatible section lengths before copying; do not silently crop, stretch or change Session originals to fit. Unwarped audio placement remains unsupported.

## Confirm current sources and destinations

The updated Remote Script provides one source-context read for placement planning. The confirmed plan binds native track, slot and clip identity plus stored MIDI notes and timing, or exposed audio settings. Replacing a source or editing its notes, loop, pitch or warp settings invalidates the plan even if its name and duration match. Source audio-file bytes, automation-envelope contents and hidden expression are not bound.

The source supports at most 4096 stored MIDI notes. A destination must have fewer than 4096 clips before copying, allowing the result to remain within the 4096-clip readback limit. Frozen sources, source recording and pending clip launches are refused. Older bridges without the placement range fail before a plan is issued. Every destination is checked again at the native write boundary; overlapping existing clips are refused.

Inspect `copyRequested`, `nativeReturned`, `placementVerified`, `sourceContextUnchanged`, `existingIntervalsPreserved`, `placedClip`, `clips` and `error` separately. Interval verification covers the observed clip objects and their exposed names, types and positions; it is not a backup or comparison of destination notes, envelopes or hidden state. Recheck the material relevant to the requested workflow independently.

Copies are separate guarded operations, so a section map can be partially built. Native exceptions, a changed interval or unavailable readback retain partial work without automatic deletion or rollback. After a failed or uncertain reply, re-list actual placements and inspect their content before continuing. Matching names alone do not establish that a placement is the intended copy. Resolve current Arrangement IDs after insertion, retain verified work and plan only missing entries. Do not replay the whole map or use global undo.

## Check the structure and listen

Verify each placed interval, complete MIDI notes or exposed audio settings, and loop/marker timing. The updated get_clip_timing read reports actual start/end markers separately from loop bounds: beats for MIDI/warped audio and seconds for unwarped audio, with supported=false when unavailable. New note IDs can differ from the Session source. Re-read Session originals and existing timeline material to check preservation. Report partial sections and readback differences explicitly.

Authorized listening follows [Arrangement audition](arrangement-audition.md), with its scoped return from Session override and global playback warning. Launching a Session scene does not audition the Arrangement. Preserve unrelated mutes, solos, routing and recording; other tracks can sound. Requested measurements use [Live audio capture](live-audio-capture.md). Save only when requested or already authorized and verify the receipt. Save As does not collect samples.

Start with [a musical sketch](musical-sketch.md), refine a chosen [instrument sound](instrument-refinement.md), or inspect shared [Arrangement context](arrangement-section.md) when those are the next musical step.

To try a sparser section while retaining complete clips, follow [clip contribution comparison](clip-contribution.md). It uses whole-clip activation and does not silently remove only part of a spanning clip.
