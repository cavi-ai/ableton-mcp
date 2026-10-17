# Shape Session clip automation

Retrieve `shape-clip-automation` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Describe the clip, control and desired motion. The default `mode: "copy"` preserves the original in place and uses a named alternative in an existing empty Session slot. `in-place` requires explicit scope for the existing clip. Both modes preserve existing target envelopes.

## Choose the lane and shape

Resolve the exact Session clip, its timing, track device hierarchy and observed parameter. MIDI and warped audio use beats; unwarped audio is refused. Absolute clip beat positions need not begin at the loop's start. Convert bars from the observed meter. Arrangement automation, mixer envelopes and continuous curves are outside this operation.

Read `get_clip_parameter_envelope` before planning. Samples cannot recover a full envelope or reveal every intervening edit. An existing lane is preserved; choose another clip/control or a separately scoped editing approach. Do not use the replacing `set_clip_parameter_envelope` tool to bypass this boundary.

Plan `create_clip_parameter_envelope` with exact `trackId`, `clipId`, `deviceId`, `parameterId`, fresh `expectedStateVersion` and 1–128 ordered, nonoverlapping `points`. Each point has absolute `time` and positive `duration` in beats, plus exactly one of:

- `value`: an exact raw native value within the observed bounds. Quantized controls require an integer choice. Values are never clamped.
- `targetDisplay`: a continuous control target such as `"200 Hz"`, `"2 kHz"`, `"200 ms"`, `"-12 dB"` or `"25 %"`. Live's formatter resolves compatible Hz/kHz and ms/s units. Decimal points are required; unsupported or unrepresentable targets are refused.

Steps are a staircase, not a continuous ramp. Resolve a requested smooth curve before substituting steps. Gaps and behavior outside sampled positions remain native envelope behavior rather than a fully verified curve.

## Create and verify

Playback must be stopped, recording off, the target clip idle and its track unfrozen. The parameter must be enabled with known inactive automation. Resolve a pause within existing authority; do not silently stop a performance, clear automation or disarm tracks.

The plan binds native owner/slot/clip/device/parameter objects, exposed clip notes or audio state and timing, and all exposed device parameter records. The bridge rechecks context and envelope absence inside the write callback. It creates one lane in one undo step, verifies interior samples and reports exact-boundary observations separately in `boundarySamples`, and compares exposed clip material. Require `observed.created`, `observed.verified` and `verificationScope: "sampled_steps"`, then independently sample the same lane. Live can return the preceding value exactly at a step boundary; interior samples verify the step to its right. This does not prove every curve point, hidden state, audible improvement or what the listener heard.

On failure, cleanup attempts to remove only the newly created lane and restore its prior parameter value when native ownership remains valid. Replaced objects or uncertain ownership prevent unsafe cleanup; partial state and cleanup failures remain explicit. After an interrupted reply, inspect the exact lane before retrying. Never clear it merely to make creation retryable.

## Audition and keep the result

A clip copy shares its track devices and, for audio, its source file. Launching it can replace the track's playback, start transport and override Arrangement playback. Audition only when authorized and preserve unrelated controls. Stopping it does not guarantee restoration of the parameter's earlier value or automation ownership; inspect actual state before planning any restoration. Keep the original and selected alternative. Further envelope edits, deletion and saving require their own scope.
