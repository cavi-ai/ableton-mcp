# Remove a whole clip

Use `remove-whole-clip` through `get_producer_workflow` or its MCP prompt for an explicitly requested whole Session or Arrangement clip deletion. Both collaborative and autonomous modes resolve the actual target and scope first. A partial phrase, temporary mute or less busy alternative needs its own editing workflow. Existing deletion authority does not require another permission question.

The `all` profile exposes `delete_clip` for Session and `delete_arrangement_clip` for Arrangement. The clip form of `delete_session_object` uses the same native guard. Install the updated bridge. Resolve the exact occupied slot or timeline interval, then inspect complete exposed notes or audio state and timing. Duplicate names and a selected track do not identify a clip.

Plan with fresh `expectedStateVersion`. Confirmation binds the native clip, owner and layout, exposed notes or audio settings/timing, and other clip inventory metadata. Native execution checks them again at undo entry before requesting one deletion. Recording/count-in, frozen or Group owners, pending target launches and changed context refuse. The bounds are 256 ordinary tracks, 4096 Session slots/scenes or Arrangement clips, and 4096 source notes or warp markers; sources are never sampled.

Deletion removes the entire native clip, including clip envelopes and note expression. The exposed snapshot is not a restorable backup. Hidden contents and edits are not compared. Removing a looping clip removes all its repetitions within that clip. Audio source files are not deleted.

Inspect `deletionRequested`, `nativeReturned`, `targetCleared`, `ownerRetained`, `otherClipsRetained`, `deletionVerified`, `error` and `observationError` separately. A native return does not prove deletion. Null clearance means the outcome is unknown. Preservation checks compare remaining native clip identities and exposed inventory metadata on the intended track, not their complete contents, hidden state or external file bytes. Re-list and resolve current IDs afterward; Arrangement indices can change.

After a partial result or lost reply, inspect what actually remains. Do not replay, reconstruct deleted contents, delete an ambiguous candidate or globally undo. An authorized recovery requires identifying the applicable history step without intervening user work; `get_history_state` availability alone does not identify it. Independently inspect any undo result. The tools issue no transport commands, but deletion can change what plays. Playback changes and saving retain their own scope.
