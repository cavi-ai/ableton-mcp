# Play a Session scene

Use `launch_scene` to audition parts together only when the entire row's effect is intended. Its dry-run plan includes every track's target clip or empty slot, stop button, Group membership, arm, monitoring, mute/solo, active clip and pending launch index. Target clips include launch mode, quantization and Legato settings. The plan also includes current recording modes, global tempo/meter/launch quantization and the scene's overrides. Reading the plan does not launch anything or move selection.

An empty slot with a stop button can stop that track. Group slots can affect descendants. Armed empty tracks may start recording according to Live's launch preference, which the bridge does not expose; `willRecordOnStart` reports the native slot property when available without predicting every scene preference. Resolve recording intent explicitly and preserve unrelated arm states. Scene tempo and meter overrides affect the whole Set. Explain these effects and reuse authorization already given before executing the confirmed plan.

When per-scene launch quantization is unavailable in the native API, its setter reports that boundary. Changing global launch quantization is a separate action affecting other launches; do not apply it automatically as a fallback.

The updated Remote Script rechecks the full observed context and native row identities immediately before firing. Changed clips, stop buttons, arms, recording state, scene overrides or replaced native objects invalidate the plan even when the state version matches. Up to 256 tracks are supported; larger Sets are refused without sampling. Plans bind launch metadata and controls, not complete notes, audio contents, device state, follow actions or the unexposed launch preference. Re-read after a stale-plan error; never weaken the guard or blindly replay a timed-out launch.

`launchRequested: true` means Live accepted the fire call. `playbackVerified: false` makes the immediate receipt's limit explicit: quantization may defer playback, and later follow actions may change it. Read transport, clip playback, recording and musical context afterward before reporting the actual result. Native scene launch may select the scene. `forceLegato: true` requests immediate Legato across its clips; it does not prove audio alignment or what reached the listener. Stop only the intended parts unless the user requested a global stop.

For a new idea, follow [musical sketch creation](musical-sketch.md). For timeline material, use [Arrangement passage audition](arrangement-audition.md).
