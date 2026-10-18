# Prepare a recording start

Use `set_transport_context` to prepare the metronome and count-in before a separately authorized recording. `countInDuration` accepts the native names `none`, `one_bar`, `two_bars`, `four_bars`, or their observed numeric values from `get_transport_context`. The metronome field is an optional boolean. This operation does not arm tracks, change routing, reposition the playhead, start playback or start recording.

## Choose the intended lead-in

Read `get_transport_context`, `get_transport_recording_context` and the current meter first. Resolve the intended start with the user: configuring a count-in is not permission to begin a take. Count-in bars follow Live's configured meter. An enabled metronome or count-in setting does not prove an audible click or an incoming performance.

Count-in preparation requires a saved Set, stopped playback and recording, macOS English Live, Accessibility and Automation access, an updated bridge and exactly one running instance of the expected Live app. Pure metronome changes continue through the native API. Live's count-in property is read-only through that API; count-in requests use the native Metronome Settings menu instead. On other platforms, inspect the current value and set count-in in Live before proceeding.

Plan `set_transport_context` with the requested fields and fresh `expectedStateVersion`. Review the dry-run plan and repeat it with its confirmation token and plan hash when authorized. Planning sends no UI input. Execution changes focus, opens the settings menu, selects only the **Count-In** radio group, and closes the owned menu. The adjacent Rhythm group also contains “1 Bar”; it is not a count-in control. Sound, rhythm and Enable Only While Recording remain unchanged.

## Verify or recover

`transportVerified: true` means native readback matches the requested count-in/metronome and the other bound document/readiness fields remain stable. It does not establish that a recording started, a click reached hardware, or a listener heard it. Read the result's actual `observed` values before starting a take.

An existing dialog or context menu is refused. Document identity, visible transport controls, popup window IDs and menu settings are checked before input. If the user edits the menu, starts playback or changes the Set, the operation refuses further input. Only an unchanged owned popup is dismissed automatically. Failed or uncertain requests report observed native values and cleanup status; a count-in change can remain applied even if a later metronome change or verification fails. Inspect current values and any remaining UI before continuing. Never retry blindly or use global undo.

Restore preparation values only when intended and after comparing current observations with the workflow's last applied values, preserving manual edits. Continue with [a Session take](session-take.md) when recording is authorized.

## Change recording modes during playback

Use `set_transport_recording_context` for confirmed Arrangement or Session recording-mode changes and automation arm. A request without `currentSongTime` allows the clock to advance while playback continues. Confirmation still binds the observed playback state, recording modes, automation arm, capture context and state version. A manual mode change requires a fresh plan.

Mode-only requests retain their control readback and existing failure behavior. Read `verification.controlsConfirmed` and actual `observed` values. Native recording commands can start playback and capture content; a control readback does not verify the take.

## Seek to an absolute song position

Supply `currentSongTime` in zero-based quarter-note beats to `set_transport_recording_context`. The updated bridge binds native Song and track collection identity plus current transport/recording controls. Stopped plans bind the observed playhead; playing plans exclude its moving position even when an absolute target is supplied. A manual seek during playback cannot be distinguished from normal clock progress by this guard. Playback-state, mode, automation-arm, capture-context or track-layout changes still invalidate the plan. The target is absolute, not a relative offset from an earlier read.

Recording and count-in must be known inactive before a seek plan. The bridge also checks exposed Session and Arrangement clip recording, skipping Groups while inspecting their ordinary child tracks. Inspection supports at most 256 tracks including Groups and 16384 combined Session slots and Arrangement clips. Unknown recording state or excess bounds refuse without sampling. A combined stop-recording-and-seek request does not bypass this check: first confirm the intended mode-only stop, read actual recording state, then plan the seek. Do not stop a user's take merely to make an unrelated navigation request succeed.

Optional mode/preparation changes in the same nonrecording seek request remain explicit. The seek is issued before preparation and recording-start commands; recording commands can start playback and capture material. Native execution rechecks inside its undo step and issues each changed control at most once. A seek with all controls already at their requested values makes no write or undo step. It requests no track selection, loop edit, clip launch or return from Session override.

Inspect `seekReceipt.seek.writeRequested`, `seekReceipt.seek.nativeReturned`, per-field `writes`, overall `nativeReturned`, `targetRetained`, `error` and `observationError`. `observed` is the transport read after Live's command callback, or null when unavailable. `verification.controlFieldsConfirmed` compares requested non-position fields; `positionVerified` requires a retained Set, returned writes, stopped playback before and after, and the observed target within 0.000001 beats. `controlsConfirmed` requires both. During playback, `unverifiedFields` includes `currentSongTime` and position verification remains false: neither an accepted setter nor a later moving playhead proves exact arrival or audible Arrangement playback. Read current transport independently before continuing.

Seek failures retain actual partial changes without automatic rollback, playhead restoration, replay or global undo. A failed setter, undo finalization or lost readback can leave the position and some requested controls changed. Inspect current controls before planning only the remaining intended work. Stored notes, recording content, automation envelopes, hidden state and audio-file bytes are not backed up or verified by a seek receipt. Playback, saving and returning Session-overridden tracks follow their own scope.
