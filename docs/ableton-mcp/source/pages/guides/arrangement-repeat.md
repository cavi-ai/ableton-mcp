# Repeat an Arrangement passage

Use `repeat-arrangement-section` for requests such as “repeat the chorus twice later in the song.” It copies complete existing Arrangement clips onto their own tracks, preserving their relative positions and the passage's gaps. Retrieve the workflow through `get_producer_workflow` or its MCP prompt. Execution requires the `all` profile and updated bridge.

```json
{
  "workflow": "repeat-arrangement-section",
  "arguments": {
    "request": "Repeat the chorus at beats 16–32 twice, starting at beat 64, on the chords, bass and drum tracks. Preserve the originals and audition the new passage.",
    "mode": "collaborative"
  }
}
```

The default `collaborative` mode proposes a structural map unless the user already chose one. `autonomous` chooses within the brief and states its decisions. Neither mode grants unrelated playback, source edits, deletion, recording or saving.

## Resolve a complete passage

Resolve exact ordinary track IDs and source/destination bounds from current tracks, clips and locators. A locator does not define its own ending. All positions are quarter-note song beats; current meter does not establish historical bar positions. Include intended muted tracks and Group children. Audio and drums excluded from tonal analysis can still belong in the section. Group, Return and Main are not clip owners.

Read complete source notes or exposed audio state, clip timing and processing. Stored note time is clip-relative; Arrangement placement is song-relative. Preserve the native loop/start-marker phase instead of regenerating notes at absolute song offsets. The clip's loop length need not equal its placed span.

## Preview the map

`plan_arrangement_repeat` reads selected track inventories and returns source metadata, proposed placements and blockers without copying, changing focus or starting playback.

```json
{
  "trackIds": ["track-0", "track-1"],
  "sourceStartBeats": 16,
  "sourceEndBeats": 32,
  "destinationStartBeats": 64,
  "repeatCount": 2
}
```

This maps two complete 16-beat windows to beats 64–80 and 80–96. A source clip at 20–28 maps to 68–76 and 84–92. Leading, internal and trailing gaps remain gaps. Exact end/start boundaries do not overlap.

`canCopy` requires a nonempty source, no `boundaryClips`, no `destinationClips` and no `plannedOverlaps`. Any clip crossing a source boundary blocks the map; the planner does not crop it. Any existing content inside the **entire** destination window on a selected track blocks it, including content in a proposed rest or on an explicitly selected empty source track. Resolve another destination or an explicitly changed passage rather than silently deleting, moving or hiding material. Empty source tracks remain listed in `emptyTrackIds`.

The source and destination windows must be disjoint. Limits are 64 tracks, 512 source beats, 16 contiguous repeats, 4096 scanned clips, 256 relevant clips and 256 placements. Exceeding a limit refuses the read instead of truncating the map. Long sequences need separate audition windows of at most 512 beats.

The result is **non-atomic inventory metadata**, not a content-bound batch, an execution authorization or a confirmation token. `stateVersion` alone does not detect manual edits. `contentVerified` and `automationVerified` are false. Each placement needs fresh observations and its own guarded confirmation.

## Copy, inspect and resume

Use `duplicate_arrangement_clip` for each placement after re-reading current inventories, source material and timing. Re-resolve source IDs after insertions; use actual owner, interval, type and content rather than names alone. Check the full destination window for unexpected new content between operations. Preserve existing processing and routing, and resolve recording, frozen/armed targets or pending launches within scope.

Independently inspect every new clip's actual interval, complete notes or exposed audio state, timing and source preservation. Copied note IDs can differ. Track verified placements against the agreed map. After a lost reply or partial result, inspect existing copies and retain verified progress before planning missing entries. A partially built destination will appear occupied to the preview tool. Reconcile exact receipts and current content; do not ignore blockers, replay the whole map or globally undo over manual work. Keep manual changes on both source and copies visible.

Requested section names use separately guarded locator creation at exact boundaries after checking existing locators. Locators do not prove missing clips were copied. Arrange Session sources through [Arrange Session ideas](session-arrangement.md) when they are the intended starting material.

## Listen and refine

Authorized listening follows [Arrangement audition](arrangement-audition.md). Resolve Session overrides and recording readiness, audition the exact copied passage, inspect actual playback and native signal activity, then ask what the user hears or make a bounded refinement within the brief. Other tracks may sound. Preserve unrelated mutes, solos, monitoring and arms. Re-read current note IDs and timing before refinement; keep intervening hand edits and original sections.

Arrangement automation envelopes, tempo/meter maps, locators, take lanes, Return/Main processing and hidden plug-in state are not verified as section copies. Audio-file bytes and rendered equivalence are also outside the preview. If those are essential to the requested result, resolve the missing scope rather than claiming a complete musical duplicate. Report actual versus planned placements, partial outcomes, playback and these limits. Cleanup and saving remain separate.
