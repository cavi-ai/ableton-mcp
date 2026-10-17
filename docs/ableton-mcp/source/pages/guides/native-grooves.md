# Try native clip grooves

Ask for a groove alternative, such as “Try the existing sixteenth swing on this drum clip; keep the original,” or for an explicit removal, such as “Remove the groove from this clip without baking it.” Retrieve `try-clip-groove` through MCP prompts or `get_producer_workflow`, with the request and optional `mode: "collaborative"` or `"autonomous"`.

## Compare an alternative

The workflow resolves the exact requested Session or Arrangement clip and reads `get_clip_groove_context`: source notes or audio state, timing, the Groove Pool and global musical context. Selection is a fallback when the request does not name a target. It does not establish what the user hears.

For Session exploration, use `duplicate_clip` into an empty compatible slot with a distinct name, preserving the original. Reuse an existing alternative when identified. Audio copies share their source file; clips on one track share processing. For Arrangement exploration, use `duplicate_arrangement_clip` with the exact source ID and a nonoverlapping `startBeats` on the same track, then re-resolve and verify the copy. It retains the source name: duplicate names prevent UI removal, although groove assignment remains available. Renaming Arrangement clips is outside these tools; report that boundary without moving or deleting the original.

Assign an actual observed Groove Pool ID through guarded `set_clip_timing`. Inspect the result and compare source content, other timing and shared context with the pre-action snapshot. Groove names and exposed percentages do not reveal the underlying pattern. This workflow does not load patterns, extract grooves or commit their playback effect into stored material.

Shared pool edits affect every clip using that groove. Global amount affects other clips too. Neither is implicitly authorized by trying a groove on one clip. At zero global amount, assigning a groove does not establish an audible feel change. Audition only within the requested scope, and ask what the user wants to keep.

## Remove an assignment

Use `set_clip_timing` with `grooveId: null`, the exact `trackId` and `clipId`, and fresh `expectedStateVersion`. Removal must be the only timing edit in that call. Review the dry-run plan and confirm it with its single-use token and hash. Skip a clip whose assignment is already empty.

Removal requires the updated bridge, English Live on macOS, Accessibility access, one matching Live process, a saved Set and a nonempty clip name unique across Session and Arrangement. Recording, frozen owners, pending launches and an existing dialog prevent preparation. A failed prerequisite does not authorize silently saving, renaming or moving material.

The bridge selects the exact target and opens Clip View. The host checks the saved document, displayed clip, assigned groove and menu; it rechecks native identity, source content, timing, shared context and selection before choosing **None**. Focus remains on the target; previous focus and playhead position are not restored. The user does not need to select it manually.

**None removes the assignment without baking.** It does not keep the groove's playback effect in stored notes, reverse an earlier bake or delete the shared pool entry. Commit Groove is outside this operation.

Require `removalVerified: true` and `ui.noneSelected: true`, then independently read `get_clip_groove_context` and call `inspect_clip_groove_postconditions` with `operation: "remove"` and the actual pre-action snapshot. `postconditionsObserved: true` and `sourceContentChanged: false` confirm assignment removal and preservation of exposed source, other timing and shared context. They do not prove audible equivalence or back up hidden state or audio bytes.

After a timeout, lost reply or uncertain UI outcome, inspect the exact target before retrying. A failed response can follow a successful native action. Do not replay blindly, duplicate again or use global undo. Preserve intervening manual edits and scope saving, deletion or further changes separately.
