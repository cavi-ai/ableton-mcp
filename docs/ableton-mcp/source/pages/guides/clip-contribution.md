# Compare a clip's contribution

Retrieve `compare-clip-contribution` through `get_producer_workflow`, or open its MCP prompt. For example: “try the bridge without the named hi-hat clips, keep their notes, and let me hear the difference.” The default `collaborative` mode proposes unresolved choices; `autonomous` chooses only within the request. Existing playback authority is reused.

## Resolve the actual material

Identify exact ordinary tracks and Session or Arrangement clips. Read `get_clip_timing` for the current `mute` state and actual timeline interval. `mute.enabled: true` means the native [Clip Activator](https://docs.cycling74.com/apiref/lom/clip/) is off. It differs from muting a track, muting individual notes, deleting a clip or stopping transport.

The flag affects the whole clip. If an Arrangement clip extends beyond the requested section, resolve the broader scope or a separate edit before changing it. Do not silently split, crop or rewrite material to approximate a partial dropout. Current meter alone does not establish historical bar positions.

Retain the original activation state and complete MIDI notes or exposed audio source/settings/timing as the relevant baseline. Keep other clips, track mutes, solos, routing and monitoring in their existing states. An inactive flag does not establish that the whole part or mix is silent.

## Compare with guarded activation

Plan `set_clip_timing` with fresh `expectedStateVersion` and only `mute: true` or `mute: false`. The updated bridge supplies `muteEditContext`, binding the native document, track, slot/clip identities, prior activation and current recording/owner controls. Equal-looking clip replacement invalidates the plan. The identity cache retains at most 64 target entries and supports Sets with at most 256 tracks; an evicted context requires a fresh plan.

Recording, count-in, frozen targets, explicit or implicit target arms, pending target launches and unknown flags refuse. Playback may continue. Do not alter unrelated recording or arms to force the edit through. An older bridge refuses the context read before confirmation; install and reload the packaged bridge first.

Execution checks the context again at undo entry and guards native identity, controls and activation around writes. It verifies native mute readback. A no-op requests no property write or undo step. Existing mixed timing edits remain supported; on failure, only still-owned applied values can be rolled back. Replaced objects or later manual changes are preserved, and partial work remains explicit. The comparison workflow uses only the mute field to keep its scope clear.

Compare `observed.mute.enabled` with the requested value and independently read timing afterward. Native identity and activation checks do not compare notes, file bytes, envelopes or hidden state. Inspect those baselines separately when claiming preservation. After a lost reply or error, inspect current clips before continuing; never replay a toggle or use global undo over manual edits.

## Listen and choose

Use an already authorized running passage, or follow [Arrangement audition](arrangement-audition.md) for a resolved passage. Arrangement playback needs the intended tracks returned from Session override; launching a Session clip does not establish that the Arrangement is being heard. This flag does not launch, seek or stop playback.

Other clips, monitoring, sends and effect tails may sound. Immediate switching does not guarantee click-free transitions, retained tails or equal loudness. Ask what the user hears before judging whether the dropout helps the music.

Keep the chosen state. Restoring the baseline requires a fresh plan, with the same current native `muteEditContext.identityToken` and activation matching this workflow's last applied observation. Preserve intervening manual edits or uncertain identity. Restoring the flag does not restore content, automation, tails or playback phase. Several clip changes are separate operations and can partially succeed. Saving, deletion and broader arrangement edits remain separately scoped.
