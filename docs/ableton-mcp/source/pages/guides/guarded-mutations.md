# Guarded mutations

Every tool that changes the Live Set uses the same contract. A plan made against one state of the Set can only run against that same state.

## The contract

1. **Observe.** Read `stateVersion` from `get_live_state`, or from the context tool the mutation names in its description.
2. **Plan.** Call the mutation with `expectedStateVersion`. If `dryRun` is omitted or `true`, nothing changes. The result is the exact plan plus a `confirmation`: `{ token, planHash, expiresAt }`.
3. **Execute.** Call the mutation again with the same arguments, plus `dryRun: false`, the `confirmationToken` and the `planHash`.

Execution is refused when:

- the Set's state version has moved since the plan,
- the plan, rebuilt from a fresh observation at execution time, no longer hashes to `planHash`,
- the token has already been used, or
- the token has expired. Tokens last 60 seconds.

Many plans also carry the observed objects themselves: the exact device, clip, notes or routing choice. The bridge rechecks that snapshot inside Live before it writes.

## Read back

A mutation's acknowledgement is not acceptance. Read the changed object again and compare it with the plan. Some UI-driven changes don't advance the bridge's state counter, so a readback is the only proof.

## Destructive operations

Tools that can remove content or overwrite device state are annotated `destructiveHint: true`. [Tools](../reference/tools.md) lists them under *Destructive mutations*. With `delete_session_object`, deleting a track or scene that holds clips or devices also requires `allowContent: true`. Deleting a Return Track always requires it. The last remaining scene cannot be deleted.

`undo` and `redo` are guarded mutations too. `get_history_state` reports whether each one is available, and a plan is refused when the requested step isn't.

## Metadata edits

`set_preset_metadata` and `set_browser_item_metadata` change local tags and favorites, not the Live Set. They take `expectedMetadataRevision` instead of a state version, and they use the same dry-run and confirmation steps.

## Fail closed

When Live's API doesn't expose a property or a setter, the tool says so in its result, or the plan refuses. It never pretends a write happened. For example, `set_track_freeze_state` plans and verifies, but Live 12.4.5 has no setter for `Track.is_frozen`, so execution fails with that reason.
