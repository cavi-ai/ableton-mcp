# Make space in a MIDI part

Use `simplify-midi-part` through `get_producer_workflow` or its MCP prompt for requests such as “leave more space in the verse hats, but keep the pickup” or “thin the chord attacks without losing the moving top voice.” The default `collaborative` mode proposes what to retain and mute; `autonomous` makes bounded musical choices within the brief. Execution requires the `all` profile. Playback and saving retain their own scope.

The workflow creates one named alternative and mutes chosen notes with `set_midi_note_properties`. It keeps the source and every note in the copy. A generic simplification does not authorize deletion: [exact note removal](midi-note-removal.md) also removes hidden expression and is a separate intention.

## Choose what creates space

Resolve the exact Session or Arrangement part, actual instrument and complete notes before choosing events. Drum pitches need the loaded rack's pad mapping. Hooks, pickups, bass motion, accents and moving chord voices can matter more than a uniform density target. A downbeat, velocity threshold or lowest pitch alone does not establish a musical role. Already sparse or ambiguous material may need clarification instead of an arbitrary reduction.

Use the clip's actual meter, loop origin, markers and source-note times. Preserve held notes crossing the chosen passage and notes outside it unless explicitly included. Source-clip beats differ from Arrangement song beats, and muting a source note affects all loop repetitions. A request to change only one repetition needs a resolved representation before editing. The current song meter and configured scale do not establish historical bar positions or a detected key. Existing note mutes remain intact.

## Preserve an alternative

For Session material, `duplicate_midi_clip_variations` creates one variant in an existing empty slot on the same track. For Arrangement, resolve an explicit empty song interval and use `duplicate_arrangement_clip` on the same track. Check the whole copied length. Do not overwrite material, create scenes or move sources merely to make room. Arrangement indices can shift after insertion; re-resolve the actual clips.

Read the copy's complete notes and timing before editing. Native copies can have different note IDs. Resolve the chosen events on that copy, including any duplicate-event ambiguity, then plan exact `mute: true` changes for currently unmuted notes. Review and confirm the unchanged plan through the [guarded mutation contract](guarded-mutations.md). A refusal is not authority to stop recording or change safety controls.

Independently compare the resulting notes, retained properties, timing and source. Preserve pitches, attacks, durations, velocities, probabilities, other mutes, devices, mixer and routing. Exposed readback does not verify every envelope or hidden per-note expression; an Arrangement copy does not establish verified automation duplication.

## Listen and refine

An authorized Session audition replaces the playing clip on that track and can start playback or override Arrangement. Inspect readiness and the prior playing clip first; keep solo, arm and monitoring unchanged. An Arrangement audition uses the exact copied window. Other tracks can sound, and listening to a copy at a different song position is not an aligned full-mix A/B comparison. Verify actual playback and native signal activity, then ask what the user hears. Stored mutes and meters do not prove musical improvement or audible note-off timing.

After a stale plan, lost reply or reconnect, inspect current clips and complete notes before continuing. Reconcile only missing intended changes; do not create another copy or replay the workflow. Preserve manual changes, including manual mute/unmute decisions. A fresh refinement may mute further events or unmute a previously owned reduction only after comparing with the last applied observation. Keep pre-existing mutes, retain partial work and both clips, and avoid blanket resets or global undo.
