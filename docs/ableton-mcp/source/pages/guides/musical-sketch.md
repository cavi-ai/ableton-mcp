# Create a playable musical sketch

Use `get_producer_workflow` in the default `all` profile to list workflows. Supply `workflow: "create-musical-sketch"` and named string `arguments` to retrieve the sketch instructions. MCP clients can also open the prompt directly. Both return the same instructions; retrieval does not call Live, execute work or grant permission.

```json
{
  "workflow": "create-musical-sketch",
  "arguments": {
    "request": "Create a four-bar chord and bass idea using the current tempo and key. Leave playback stopped.",
    "mode": "autonomous"
  }
}
```

## Choose how to work

The default `collaborative` mode offers two directions and lets the user choose before building, unless the request already chooses a direction. `autonomous` lets the agent make compositional decisions within the brief without asking about every creative detail. Neither mode authorizes unrelated edits, deletion, playback, recording or saving. Include those requests in the brief when wanted. An unspecified length starts with a proposed four-bar sketch.

The workflow reads the current Set, recording state, meter, tempo and configured scale. The configured scale is a compositional constraint, not a detected key. Existing context stays in place unless global changes are authorized. An optional new absolute `.als` `setPath` creates a separate working Set through guarded Save As before building; verify its receipt and loaded path. Save As does not collect samples.

## Compose directly in Arrangement

Set `location: "arrangement"` in the `create-musical-sketch` workflow arguments to write a new MIDI part at a timeline position. `location: "session"` remains the default. The same collaborative/autonomous modes apply; resolve the intended section from actual locators and passages rather than inferring historical bar positions from the current meter. Existing ordinary MIDI tracks retain their processing; append new instrument tracks only within the brief. Creation requires no Session clip or scene.

Use `create_arrangement_midi_clip` with `trackId`, absolute `startBeats`, positive `lengthBeats`, explicit `name`, `notes` and fresh `expectedStateVersion`. Notes use pitch, relative clip-beat start/duration, velocity and optional mute; every note must fit the span. The complete destination interval must be empty. Names must be nonempty, at most 128 characters and contain no control characters. The tool supports 256 tracks, room for one clip within 4096 Arrangement clips, up to 4096 notes, and an interval within 0 to 1576800 beats.

The plan binds the native track and existing clip layout and rechecks at undo entry. Frozen/non-MIDI tracks, overlaps, recording/count-in and changed destinations refuse. The native creation must yield one new empty MIDI clip with the intended interval before naming or note insertion. Initial notes use probability 1, velocity deviation 0 and release velocity 0; richer edits need a separate guarded note-property operation on the actual returned IDs. Empty requested parts skip the native empty-note write.

Inspect `creationRequested`, `nativeReturned`, `nameWriteReturned`, `notesWriteRequested`, `notesWriteReturned`, `verified`, `ownerRetained`, `existingLayoutPreserved`, `createdClipId`, `observedClip`, `observedNotes`, `observedTiming`, `clips` and errors independently. Verification compares the requested name, interval and complete basic-note set, including initialized defaults; note timing permits an absolute 0.000001-beat native precision tolerance. Loop/marker timing is returned for independent inspection. Existing-layout checks cover native clip identities and timeline records, not a backup of complete content or hidden state.

Partial creation, initialization or finalization failures retain actual work without rollback or replay. A failed native call or lost reply may leave a new clip with unconfirmed ownership. Re-list and inspect candidates before continuing; never delete an ambiguous clip or globally undo over manual edits. Read new notes and timing before refinements. Authorized listening follows [Arrangement audition](arrangement-audition.md), considering Session overrides and other sounding tracks. Creation does not start or stop playback, recording, change focus or establish audible output.

## Build Session parts

Append a named scene and new MIDI tracks, resolve their current IDs and empty slots, then find instruments actually available in Live. Load only onto the new tracks, then re-read their arm state and leave them unarmed. Preserve arm states on unrelated tracks. A processing chain alone need not contain an instrument; an empty Drum Rack is not a populated kit. Inspect actual pad/sample mappings before choosing drum lane notes.

Coordinate the requested chord, bass, melody and drum parts using the scale/grid planners and guarded clip-creation tools. Use the same intended length, meter and progression across related parts. Compare complete native note readback with each plan, check loop timing, then inspect devices, mixer and routing. Preserve existing clips and instruments. After interruption, inspect created material before retrying so a lost reply does not produce duplicates.

## Listen and refine

Audition only when requested or authorized. Launching new Session clips can start playback; separate launches do not establish phase alignment. For a [scene launch](scene-launch.md), review the full-row dry-run plan, including empty stop buttons, armed tracks, recording state and scene tempo/meter overrides. Resolve authority for its full effect first. Require `launchRequested: true`, then read actual clip playback, recording and musical context; the immediate receipt does not certify playback. Stop created clips for a local stop; stop transport only for an intended global stop. Do not change unrelated mutes, monitoring or recording to isolate the sketch automatically.

Discuss what the user hears, or make an authorized bounded refinement in autonomous mode. Re-read affected material before edits and preserve manual changes. Use clip or instrument variations for alternatives. Stored-state checks do not establish audible output or musical quality. Requested measurements use a separately authorized [Live audio capture](live-audio-capture.md), with its complete-file and cleanup checks. Save or delete only when requested or already authorized.

To develop the Session parts into named sections, follow [Arrange Session ideas](session-arrangement.md). The same tool provides [Set orientation](session-orientation.md), [instrument comparison](instrument-comparison.md), [musical part context](musical-parts.md) and [resuming interrupted work](resume-session-work.md). Listings describe required and optional arguments. Missing, unknown or non-string arguments are rejected before returning instructions.

To write bass, melody or harmony against existing material, follow [Write a supporting part](supporting-parts.md). It establishes a shared passage before creating a separate playable part.
