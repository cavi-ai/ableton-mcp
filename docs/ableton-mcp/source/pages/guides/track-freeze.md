# Freeze and unfreeze track processing

Use `freeze-track-processing` through `get_producer_workflow` in the `all` profile when a user wants to freeze a named part for playback or unfreeze it for editing. Freezing renders the track's Session and Arrangement clips so Live can play cached audio instead of processing its devices in real time. Unfreezing restores access to the original processing. This operation does not bounce a track, delete devices, save the Set or start playback.

## Prepare one track

Read the current Set, selection and `get_track_freeze_state`. Resolve the exact ordinary audio/MIDI track and intended state. Do not choose tracks from guessed CPU costs. Preserve any performance in progress: execution requires stopped playback and recording, an unarmed target and no pending launches. Stop or disarm only within the user's intended scope.

The native command requires macOS English Live, Accessibility and Automation access, a saved Set, an updated bridge and one expected Live instance. The target must be visible in the current Session or Arrangement view; unfold a containing Group separately if intended. Groups, Returns, Main, tracks without clips and freezing known External Instrument/External Audio Effect devices are refused. External hardware can require a real-time render dialog that needs preparation in Live. Live can also refuse freezing because another track receives the target's MIDI; preserve that routing rather than changing it to force a render.

Plan `set_track_freeze_state` with `trackId`, `frozen` and fresh `expectedStateVersion`. Planning sends no UI input. The confirmed plan binds native document/track/clip/device identities, exposed notes, timing and track/device controls. It does not bind automation envelopes, hidden plug-in state or external file bytes. Execution changes focus and navigates visible track headers, leaving only the named track selected. It requires a singular Freeze Track or Unfreeze Track menu command and checks Live's selected track before pressing it.

## Verify and continue

Require `freezeVerified: true` and the requested native `freeze.frozen` value before editing or relying on frozen playback. Verification checks native identity, other tracks' freeze flags, stopped readiness and idle UI. It does not prove saved state, lower measured CPU use, audio equivalence or full material preservation. Some original clip/device edits remain unavailable while frozen. Session freeze tails and nondeterministic processing can differ; listen before accepting the result.

If rendering takes longer than the observation window, a dialog appears, a reply is lost or verification fails, inspect Live and read `get_track_freeze_state` before continuing. An accepted command can still finish after a request is cancelled. Never replay an uncertain command, cancel a render, bounce a track, or use global undo as automatic recovery. Only an unchanged popup owned before the command is dismissed automatically. Keep partial results and manual changes.

After unfreezing, refresh clip/device context before the intended edit. Freeze again only when requested or already authorized. Save through the separate guarded Set workflow when intended.
