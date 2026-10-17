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
