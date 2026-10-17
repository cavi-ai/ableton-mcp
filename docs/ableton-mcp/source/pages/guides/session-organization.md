# Organize names and colors

Use `organize-session` with an explicit request such as “keep the existing names, make these drum tracks red, and match their selected clips.” Resolve the exact tracks, Returns, Main, scenes and clips first. Colors supplement useful names; they should not be the sole way to identify a part. A name or instrument is evidence to discuss, not proof of a musical role.

## Read and apply colors

The `all` profile provides `get_live_object_colors` and `set_live_object_colors`. Read one to 64 unique canonical IDs:

| Object | ID |
|---|---|
| Ordinary or Group Track | `track-N` |
| Return | `return-N` |
| Main | `master` |
| Scene | `scene-N` |
| Existing Session clip | `track-N:clip-M` |
| Existing Arrangement clip | `track-N:arrangement-clip-M` |

The read returns each native name, RGB `color`, `colorIndex` and `supported` status without moving focus. An uncolored scene has `color: null` and its native unassigned index (`null` on the tested Live, or `-1` when returned); it can receive an explicit color. Empty slots are refused. Resolve IDs from current lists; indices alone are not persistent identities.

Plan an explicit map, using fresh Set guards:

```json
{
  "changes": [
    {"objectId": "track-2", "color": "#FF0000"},
    {"objectId": "track-2:clip-0", "color": "#FF0000"}
  ],
  "expectedStateVersion": 12,
  "expectedSetFingerprint": "use-the-current-observed-fingerprint"
}
```

Review the inert plan before confirming its single-use token and hash. It binds current native objects, names, colors and selection; intervening manual changes invalidate it even at the same bridge state version. Native execution rechecks every target between writes and groups the edits into one Live undo step. It requests no playback or musical changes. Track color inheritance may also change the appearance of Rack chains; clips are recolored only when explicitly listed.

Live can choose a nearby palette color. Inspect `writeCompleted`, `identityRetained`, `selectionUnchanged` and every object's actual `color`, `colorIndex`, `writeReturned` and `exactMatch`. `writeCompleted` means the writes returned and their observed native results were retained; it does not mean every requested RGB was represented exactly. Use an observed reference color for subsequent matching. Native color access is documented for [Track](https://docs.cycling74.com/apiref/lom/track/), [Scene](https://docs.cycling74.com/apiref/lom/scene/) and [Clip](https://docs.cycling74.com/apiref/lom/clip/).

Partial edits remain after a failure. Inspect their returned observations and read current colors before creating a new plan. A lost reply is never permission to replay. Do not automatically undo over intervening manual edits.

## Names remain explicit

`rename_session_object` separately handles tracks, Returns, scenes and Session clips. Return names use the raw label without Live's automatic bus letter. Each rename needs its own fresh guarded plan and name readback. It does not rename Arrangement clips. Organization does not silently move tracks, create Groups, rewrite notes or replace clips to change a label.
