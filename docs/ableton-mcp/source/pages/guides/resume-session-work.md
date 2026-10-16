# Resume work after an interruption

Use the `resume-session-work` prompt when continuing after cancellation, a lost connection, or edits made while the agent was away. Give it the current request, such as “continue comparing the bass instruments,” and optionally a prior task summary in `previousContext`. Retrieving the prompt does not call Live or execute the task. The agent follows it using the tools available to its client.

## Establish what is open now

The workflow reads `get_session_orientation` and `get_live_state` to establish the current Set, playback, recording, selected part and musical context. The configured key and bounded MIDI evidence remain distinct. Resuming does not automatically reopen a Set, move selection, stop playback or restore earlier material.

The agent uses authorization already given in the conversation and asks only when the desired continuation is unclear. A copied task summary helps identify what to inspect; it does not establish permission, prove an operation completed or authenticate earlier content. If another Set is open, the agent resolves which Set you intend before switching, unless your request already specifies the switch.

## Find unfinished comparisons and captures

`get_instrument_comparison` without an ID lists retained instrument comparisons. Read the relevant handle to obtain the current original and alternative track/clip IDs. `get_live_audio_capture` without an ID lists capture handles, including recordings that continued after their client exited. Inspect a capture's status and cleanup errors before analysis, cancellation or release.

These recovery tools require the `all` profile. An unavailable tool does not mean there is no unfinished work. Handles live in the bridge and survive client reconnects. Bridge reloads or Live restarts may invalidate them; always list and inspect current handles. Missing handles do not establish whether their tracks or files still exist. Inspect retained material before repeating preparation or recording; old indices and matching names alone cannot identify an intended target safely.

For two explicitly resolved existing MIDI parts, use `adopt_instrument_comparison` to bind a new handle with fresh guards instead of preparing another copy. Resolve ambiguous identity with the user. Adoption leaves tracks, content, mutes, playback and selection as they are. Its `restoreMutes` preserve both mutes observed at adoption, not an unknown earlier baseline; `restorationBasis` is `adoption`. See [instrument comparisons](instrument-comparison.md) for eligibility and limits. Audio capture handles cannot be adopted this way.

## Preserve edits made since the last observation

Read the affected parts using current IDs: complete MIDI notes and clip timing, audio clip state, device lists, and exposed track-state snapshots when mixer, routing or parameter changes matter. Compare those results with actual earlier observations if available. Distinguish an object's changed address from changed content.

`stateVersion`, a Set path or `setFingerprint` alone cannot prove that content is unchanged. Without a comparable baseline, the agent describes the present content and reports earlier differences as unknown. It cannot reconstruct missing history from a summary. Reading does not undo edits, restore snapshots, delete alternatives or repair the session automatically.

## Continue only the remaining work

The agent briefly explains the current context, unfinished work, observed differences, unknowns and next authorized action. A lost reply may hide an operation that finished in Live. Read its actual target and requested postconditions before deciding whether anything remains. An empty handle list or a start receipt alone cannot resolve that outcome.

Each remaining mutation needs a fresh guarded plan and readback. Do not replay an old write or reuse its plan/token after an interruption. If the requested change is already present, leave it in place and explain that result. Preserve intervening edits rather than recalling an earlier snapshot or applying global undo.

For a running capture, allow its requested duration plus three seconds, with up to three further seconds for stop readback. Cancel only when requested or already authorized. See [Capture Live audio](live-audio-capture.md) for partial recordings, stable-file checks and analysis limits, and [Cancel agent work](request-cancellation.md) for uncertain request outcomes.
