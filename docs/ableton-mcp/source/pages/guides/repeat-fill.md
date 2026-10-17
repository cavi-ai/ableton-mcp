# Perform a temporary Repeat fill

Ask for a short gesture such as “Try a half-second triplet fill on this drum part.” Retrieve `perform-repeat-fill` through MCP prompts or `get_producer_workflow`, passing the request. The workflow resolves the exact track and native Beat Repeat before touching controls. Explicit targets take precedence over selection.

## Prepare the effect

These tools require the updated Remote Script and `all` profile. The target must be a native Beat Repeat on an ordinary track, including an observed nested rack path when applicable. Playback must already be active and authorized. The source must be unfrozen, with source recording off, the device active, and Repeat enabled, unautomated and currently **Off**. No clip, transport, arm, routing or bypass changes are implied.

Read `get_beat_repeat_performance_context` first. It exposes native Grid/Interval choices and other parameters. Set an intended division with the existing guarded grid or interval tools, using actual display labels. Inspect Mix Type, Chance, Gate and Block Triplets as well: a control label is not proof of the intended sound.

**Repeat Off is not bypass.** Automatic Chance/Gate repetitions and other effect settings remain unchanged. The temporary fill owns only the Repeat switch. Preparing manual-only behavior, adding an effect or changing other controls needs the requested scope and its own guarded plans. Keep existing devices and source material.

## Start and inspect

Call `perform_beat_repeat_fill` with the exact `trackId`, `deviceId`, `durationSeconds` between 0.25 and 8, and fresh `expectedStateVersion`. Review its dry-run plan and confirm the unchanged hash and single-use token. The native callback rechecks source identity, device/parameter objects and exposed controls, registers change observation, sets Repeat **On**, and retains a `fillId`.

Duration uses a monotonic wall clock. Release runs on a subsequent Live display tick, independently of the MCP client. It is not a quantized gesture, beat scheduler or hard real-time deadline; a blocked Live main thread can delay it. A duration derived from beats at the current tempo is an approximation. Short fills may finish before the next client observation.

Use `get_beat_repeat_fill` with `fillId` to inspect the current result, or omit it to list retained handles after a timed-out start or reconnect. Do not blindly start again after a lost reply. Native object references allow the handle to resolve current IDs after track insertion; moving the device to a different owner or replacing it prevents the old handle from writing to the replacement.

Terminal `complete` or `cancelled`, `releaseVerified: true`, current `repeatOffObserved: true` and empty `cleanupErrors` establish a verified owned release. `releaseVerified` records the earlier guarded release; `repeatOffObserved` reads the current switch. A later manual On can therefore leave historical release verification true while the current Off observation is false. Neither proves a captured buffer, effect output, dry-signal restoration, sound quality or what the listener heard.

## Cancel, preserve manual edits and recover

Use guarded `finish_beat_repeat_fill` with `cancel: true` to request early release. Expiry can race cancellation; refresh a stale plan. Without cancellation, wait for a terminal result and finish its handle. Finishing retains the effect and its settings. Up to four fills can be active and 16 handles retained; release completed handles before starting more.

An observed external Repeat change relinquishes ownership and produces `superseded`. The user's later On is preserved. Same-value assertions and transient changes that are not observed cannot be distinguished. Changes to other controls remain intact; the fill does not restore a whole parameter snapshot or use global undo.

Stopped playback requests an early owned release. Native identity loss, a disabled switch, source recording, automation ownership or cleanup failure can prevent verified Off; these produce `cleanup_failed` with details. Listener cleanup failure is also explicit even when Off was observed. Inspect the actual device and recording/automation state before separately authorized recovery. Releasing a terminal handle does not repair its control or erase the reported failure.

If a native change listener cannot be removed, finishing refuses to release its handle so cleanup can be retried. Shutdown also retries terminal listener cleanup. The bridge attempts owned Repeat release during shutdown while native objects remain valid. Handles are runtime state and are not saved in a Set. Changing Sets, reloading scripts or restarting Live can invalidate them; a missing handle does not prove Repeat is Off. Read actual parameters before continuing. Stop playback, delete an effect or save only within the requested scope.
