# Shape stereo placement

Retrieve `shape-stereo-image` through `get_producer_workflow` in the `all` profile, or open its MCP prompt. Resolve the exact track, Group, Return or Main before changing placement. Group and Main edits affect the whole stage; Return edits can affect shared effect tails.

## Inspect the active mode

`get_mixer_panning_context` takes `trackId`: a canonical `track-N`, `return-N` or `master`. It reads native mixer and parameter identities, mode, Stereo balance and both Split Stereo values, displays, bounds, enablement and automation. Unsupported fields remain explicit. It does not change selection or playback.

Stereo `pan` balances the stereo signal. Split Stereo `left` and `right` place the two input channels independently. They are not separate output gains or measured width percentages. Use the observed native bounds: normally -1 is left, 0 center and +1 right. No width formula or audible result is inferred. See the [native mixer reference](https://docs.cycling74.com/apiref/lom/mixerdevice/).

## Confirm mode and positions separately

`set_mixer_panning` requires `trackId` and fresh `expectedStateVersion`. Supply either `mode: "stereo"` / `mode: "splitStereo"`, or active parameter values: `pan` in Stereo, `left`, `right` or both in Split Stereo. Mixing mode and position changes is refused. Values are finite native values within -1 to +1 and the actual parameter bounds, without clamping.

Review the dry-run warning and confirm its unchanged single-use token and plan hash. A mode switch can affect all native pan values. Read them again before making a separate position plan; do not assume old values transfer to the new mode. Mode changes require all three pan parameters available, continuous and with automation known inactive. Position edits require the edited active controls enabled, continuous and with automation known inactive. Recording, count-in and frozen or unknown target state are refused. Inspection remains available. Do not disable automation or stop recording merely to pass these conditions.

Legacy track, bulk, Return and Main single-pan setters refuse Split Stereo or unknown modes. Snapshot recall that would change a stored Stereo balance also refuses those modes; existing snapshots do not capture or restore a complete stereo image.

Legacy pan writes recheck the mode immediately before assignment. Their pan rollback requires the original native owner, mixer and parameter and known Stereo mode. If that evidence changes, restoration is skipped and the failure is reported; inspect the resulting partial state instead of replaying or forcing the old mode.

## Inspect the result

Requests happen immediately. Later native callbacks only observe; they do not replay commands. `verified` reports observed mode, native identity, requested values, relevant safety and preserved transport context. `requestedControls` records attempted setters, including a failed attempt; matching values need no setter. `partial` retains observed work without rollback. After a lost reply or manual edit, read context and continue only missing work with a fresh confirmation.

For a position edit, unrequested parameters must remain unchanged. For mode changes, `unrequestedValuesPreserved` is `null`: all resulting values are reported, and preservation is not claimed. Playback is preserved, without seeking. An advancing playback clock does not invalidate the plan by itself.

These are native control and readback checks, not timed sweeps, beat scheduling, automation-envelope editing, perceptual width, loudness matching, mono compatibility or audible-quality proof. Listen within the authorized playback scope. Recording and saving remain separate actions.

Audio export readiness includes these observed modes, values, automation states and native parameter identities for all ordinary tracks, Groups, Returns and Main. Changing them invalidates the observed mix context even without a state-version increment. Automation envelopes, device stereo processing and hidden state remain outside that check.
