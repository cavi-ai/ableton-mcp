# Shape Session clip automation

Retrieve `shape-clip-automation` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the clip, control and desired motion. The default `mode: "copy"` preserves the original in place and uses a named alternative in an existing empty Session slot. `in-place` requires explicit scope for the existing clip. Both modes preserve existing target envelopes.

## Choose the lane and shape

Resolve the exact Session clip, its timing and observed device or mixer control. MIDI and warped audio use beats; unwarped audio is refused. Absolute clip beat positions need not begin at the loop's start. Convert bars from the observed meter. Arrangement automation and continuous curves are outside this operation.

Read `get_clip_parameter_envelope` before planning. Samples cannot recover a full envelope or reveal every intervening edit. An existing lane is preserved; choose another clip/control or a separately scoped editing approach. Do not use the replacing `set_clip_parameter_envelope` tool to bypass this boundary.

Plan `create_clip_parameter_envelope` with exact `trackId`, `clipId`, `deviceId`, `parameterId`, fresh `expectedStateVersion` and 1–128 ordered, nonoverlapping `points`. Each point has absolute `time` and positive `duration` in beats, plus exactly one of:

- `value`: an exact raw native value within the observed bounds. Quantized controls require an integer choice. Values are never clamped.
- `targetDisplay`: a continuous control target such as `"200 Hz"`, `"2 kHz"`, `"200 ms"`, `"-12 dB"` or `"25 %"`. Live's formatter resolves compatible Hz/kHz and ms/s units. Decimal points are required; unsupported or unrepresentable targets are refused.

Steps are a staircase, not a continuous ramp. Resolve a requested smooth curve before substituting steps. Gaps and behavior outside sampled positions remain native envelope behavior rather than a fully verified curve.

## Create and verify

Playback must be stopped, recording off, the target clip idle and its track unfrozen. The parameter must be enabled with known inactive automation. Resolve a pause within existing authority; do not silently stop a performance, clear automation or disarm tracks.

The plan binds native owner/slot/clip/device/parameter objects, exposed clip notes or audio state and timing, and all exposed device parameter records. The bridge rechecks context and envelope absence inside the write callback. It creates one lane in one undo step, verifies interior samples and reports exact-boundary observations separately in `boundarySamples`, and compares exposed clip material. Require `observed.created`, `observed.verified` and `verificationScope: "sampled_steps"`, then independently sample the same lane. Live can return the preceding value exactly at a step boundary; interior samples verify the step to its right. This does not prove every curve point, hidden state, audible improvement or what the listener heard.

On failure, cleanup attempts to remove only the newly created lane and restore its prior parameter value when native ownership remains valid. Replaced objects or uncertain ownership prevent unsafe cleanup; partial state and cleanup failures remain explicit. After an interrupted reply, inspect the exact lane before retrying. Never clear it merely to make creation retryable.

## Create volume or Return-send steps

For rhythmic level changes or stepped send movement, read `get_track_mixer` on the clip's own ordinary track. Choose `mixerControl: "volume"` for its fader, or `mixerControl: "send"` with the exact observed `sendId` and matching `returnTrackId`. Confirm the Return name; duplicate names alone do not identify a send. Volume requests omit send and Return IDs. Pan, rack-chain mixer controls and Return/Main clips are outside this operation.

Read the lane through `get_clip_mixer_envelope`, with optional `sampleTimes` in absolute clip beats. This read preserves focus and playback. An existing lane must remain in place. Plan `create_clip_mixer_envelope` with the same selector, fresh `expectedStateVersion` and 1–128 ordered steps. Each step uses either an exact raw native `value` or a finite dB `targetDisplay`, such as `"-24 dB"` or `"-6 dB"`. Native formatters resolve dB targets without moving the fader or send; raw values are never clamped. `-inf` display targets are not accepted; an explicitly intended silent step can use the observed verified native minimum.

The stopped-playback, recording, freeze and automation checks also apply to mixer creation. Plans bind the native clip, mixer, volume/pan/send parameter objects, Return topology, all exposed mixer parameter records and clip material. A changed Return invalidates the plan even when its name matches. Return processing, send pre/post settings and routing are outside this verification context. Confirm the unchanged plan and independently sample the new lane's interiors. Boundary samples, partial-failure cleanup and the limits of sampled verification follow the device-lane rules above.

A copied clip shares its track fader, sends and Return processing. Launching its envelope can change those controls and automation ownership; stopping the clip does not guarantee their earlier static values return. Keep source material and unrelated lanes, and inspect actual mixer state before any separately scoped restoration. A stored level envelope does not establish audible ducking, wet/dry balance or musical improvement.

## Audition and keep the result

A clip copy shares its track devices and, for audio, its source file. Launching it can replace the track's playback, start transport and override Arrangement playback. Audition only when authorized and preserve unrelated controls. Stopping it does not guarantee restoration of the parameter's earlier value or automation ownership; inspect actual state before planning any restoration. Keep the original and selected alternative. Further envelope edits, deletion and saving require their own scope.

## Explicit whole-lane replacement

Use `set_clip_parameter_envelope` only when the intended operation is to set raw native steps or explicitly replace an entire existing lane. An existing envelope requires `replaceExisting: true`; omission or false preserves it. The flag authorizes discarding the whole curve, including points that were not sampled. It does not authorize edits to another lane or clip. The default copy workflow does not grant that authority.

The updated bridge binds native clip/device/parameter/envelope objects, exposed clip content, device parameter records and samples across the clip and requested steps. Replaced objects and changes in these observations invalidate the plan, including at the same state version. Sampling cannot detect every manual edit between probes. Read the warning and resolve concurrent editing before approving a whole-lane discard; never describe the samples as a complete curve backup.

This tool accepts 1–512 ordered, nonoverlapping steps, retaining the capacity of `plan_grid_envelope_pattern`. Numeric targets retain the tool's native clamping; the plan reports both `requestedValue` and the applied `value`. Quantized controls require integer choices after clamping. Stopped playback, recording off, an unfrozen owner and an enabled target with known inactive automation are required. Unwarped audio remains outside its beat-based timing scope.

Execution rechecks the context before clearing, uses one undo step and verifies new step interiors. Exact-boundary observations are reported separately. For an absent lane it uses guarded creation and attempts scoped cleanup on failure. For an existing lane, failure after clearing preserves the actual partial state and reports that the old curve was not backed up; it cannot reconstruct or restore that curve from samples. Inspect the exact lane before any retry and never replay a replacement after a lost reply. Saving, playback and any later restoration need their own scope.
