"""Reflect chosen native MIDI note spans inside an explicit clip-beat window."""
import math
from bisect import bisect_left, bisect_right
import re
try:
    from .bridge import _midi_clip, _track, _midi_note_record, _undo_step
    from .midi_note_removal import context as _source_context
except ImportError:
    from bridge import _midi_clip, _track, _midi_note_record, _undo_step
    from midi_note_removal import context as _source_context

_EPSILON = 2e-7
_FIELDS = ("pitch", "start", "duration", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute")


def context(song, params, version):
    track_id, clip_id = params.get("trackId"), params.get("clipId")
    if not isinstance(track_id, str) or not re.fullmatch(r"track-(?:0|[1-9][0-9]*)", track_id):
        raise ValueError("canonical ordinary track ID required")
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id)+r":(?:clip|arrangement-clip)-(?:0|[1-9][0-9]*)", clip_id):
        raise ValueError("canonical exact MIDI clip ID required")
    if len(song.tracks) > 256:
        raise ValueError("MIDI reversal supports at most 256 tracks")
    _, owner = _track(song, track_id)
    clips = owner.arrangement_clips if ":arrangement-clip-" in clip_id else owner.clip_slots
    if len(clips) > 4096:
        raise ValueError("MIDI reversal supports at most 4096 clips per collection")
    # Reuse the complete read-only note/identity/timing context; no removal is requested.
    result = _source_context(song, params, version)
    result.pop("removeSupported")
    clip, _ = _midi_clip(song, track_id, clip_id)
    result["modifySupported"] = callable(getattr(clip, "get_notes_by_id", None)) and callable(getattr(clip, "apply_note_modifications", None))
    return result


def _tree(values, combine):
    tree = [0]*len(values)+values
    for index in range(len(values)-1, 0, -1):
        tree[index] = combine(tree[index*2], tree[index*2+1])
    return tree


def _range(tree, left, right, combine, neutral):
    left, right = left+len(tree)//2, right+len(tree)//2
    value = neutral
    while left < right:
        if left % 2:
            value = combine(value, tree[left]); left += 1
        if right % 2:
            right -= 1; value = combine(value, tree[right])
        left, right = left//2, right//2
    return value


def _collision_index(notes, selected):
    buckets = {}
    for note in notes:
        if note["noteId"] not in selected and note["duration"] > _EPSILON:
            buckets.setdefault(note["pitch"], []).append(note)
    result = {}
    for pitch, retained in buckets.items():
        starts = sorted(retained, key=lambda n:n["start"])
        ends = sorted(retained, key=lambda n:n["start"]+n["duration"])
        result[pitch] = ([n["start"] for n in starts], _tree([n["start"]+n["duration"] for n in starts], max),
                         [n["start"]+n["duration"] for n in ends], _tree([n["start"] for n in ends], min))
    return result


def _new_collision(change, index):
    old = change["previous"]
    if old["duration"] <= _EPSILON or old["pitch"] not in index:
        return False
    starts, maximum_ends, ends, minimum_starts = index[old["pitch"]]
    new_start, new_end = change["start"], change["start"]+old["duration"]
    if new_start > old["start"]:
        left = bisect_left(starts, old["start"]+old["duration"]-_EPSILON)
        right = bisect_left(starts, new_end-_EPSILON)
        return _range(maximum_ends, left, right, max, -math.inf) > new_start+_EPSILON
    left, right = bisect_right(ends, new_start+_EPSILON), bisect_right(ends, old["start"]+_EPSILON)
    return _range(minimum_starts, left, right, min, math.inf) < new_end-_EPSILON


def plan(notes, ids, operation):
    if not isinstance(operation, dict) or set(operation) != {"type", "startBeats", "endBeats"} or operation["type"] != "reverseTime":
        raise ValueError("reverseTime requires exactly startBeats and endBeats")
    start, end = operation["startBeats"], operation["endBeats"]
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end)) or not 0 <= start < end or end-start > 1024:
        raise ValueError("finite nonnegative increasing clip-beat window of at most 1024 beats required")
    if (not isinstance(notes, list) or len(notes) > 4096 or
            any(type(n.get("noteId")) is not int or n["noteId"] < 0 for n in notes) or len({n["noteId"] for n in notes}) != len(notes)):
        raise ValueError("complete notes with unique native IDs required")
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 4096 or any(type(i) is not int or i < 0 for i in ids) or len(set(ids)) != len(ids)):
        raise ValueError("1-4096 unique native note IDs required")
    for n in notes:
        if any(type(n.get(k)) not in (int, float) or not math.isfinite(n[k]) for k in ("start", "duration")) or n["start"] < 0 or n["duration"] <= 0 or not math.isfinite(n["start"]+n["duration"]):
            raise ValueError("finite complete source note timing required")
    old = {n["noteId"]:n for n in notes}
    if not set(ids).issubset(old):
        raise ValueError("unknown note ID")
    changes = []
    for note_id in sorted(ids):
        n = old[note_id]
        if n["start"] < start or n["start"]+n["duration"] > end:
            raise ValueError("selected whole note span lies outside the reversal window")
        reflected = start+(end-(n["start"]+n["duration"]))
        if reflected != n["start"]:
            changes.append({"noteId":note_id, "previous":n, "start":reflected})
    # Reflecting two selected spans preserves their overlap. Only retained notes
    # can introduce a new collision; indexed starts/ends bound each query.
    index = _collision_index(notes, set(ids))
    if any(_new_collision(change, index) for change in changes):
        raise ValueError("reversal would create a new same-pitch overlap")
    return changes


def _matches(a, b):
    return a["noteId"] == b["noteId"] and all(abs(a[k]-b[k]) <= _EPSILON if k in ("start", "duration", "probability") else a[k] == b[k] for k in _FIELDS)


def apply(song, params, version):
    before = context(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("MIDI reversal source changed after planning")
    if not before["modifySupported"] or any(value is not False for value in before["editContext"].values()):
        raise ValueError("resolve MIDI modification support, recording, count-in, frozen state and pending launch")
    changes = plan(before["notes"], params.get("noteIds"), params.get("operation"))
    if changes != params.get("changes"):
        raise ValueError("MIDI reversal changes do not match the native plan")
    clip, _ = _midi_clip(song, params["trackId"], params["clipId"])
    attempted, returned, error = False, False, None
    try:
        if changes:
            with _undo_step(song):
                if context(song, params, version) != before:
                    raise ValueError("MIDI reversal source changed before write")
                native = clip.get_notes_by_id(tuple(c["noteId"] for c in changes))
                current = {_midi_note_record(n)["noteId"]:_midi_note_record(n) for n in native}
                if set(current) != {c["noteId"] for c in changes} or any(current[c["noteId"]] != c["previous"] for c in changes):
                    raise ValueError("native note vector changed before reversal")
                starts = {c["noteId"]:c["start"] for c in changes}
                for n in native:
                    n.start_time = starts[int(n.note_id)]
                if context(song, params, version) != before:
                    raise ValueError("MIDI reversal source changed before apply")
                attempted = True
                clip.apply_note_modifications(native)
                returned = True
    except Exception as failure:
        if not attempted:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {"stateVersion":version+1, "trackId":params["trackId"], "clipId":params["clipId"],
              "writeRequested":attempted, "nativeReturned":returned, "reversalVerified":False,
              "noteIdsPreserved":None, "unrequestedNotesPreserved":None, "clipTimingPreserved":None,
              "targetIdentityPreserved":None, "hiddenExpressionVerified":False, "observed":None, "error":error,
              "limitation":"Only exposed note starts are reflected. Durations and other exposed properties are compared; hidden expression and envelopes are not reversed or verified. No automatic rollback or replay."}
    try:
        observed = context(song, params, version+1)
        old, current = ({n["noteId"]:n for n in records} for records in (before["notes"], observed["notes"]))
        changed = {c["noteId"]:c for c in changes}
        expected = {i:{**n, "start":changed[i]["start"]} if i in changed else n for i,n in old.items()}
        ids_same = set(old) == set(current)
        preserved = all(current.get(i) == n for i,n in old.items() if i not in changed)
        timing = {**observed["clipTiming"], "stateVersion":version} == before["clipTiming"]
        identity = observed["identityToken"] == before["identityToken"]
        verified = error is None and (not attempted or returned) and identity and ids_same and preserved and timing and all(_matches(current[i], n) for i,n in expected.items())
        result.update(observed=observed, reversalVerified=verified, noteIdsPreserved=ids_same, unrequestedNotesPreserved=preserved,
                      clipTimingPreserved=timing, targetIdentityPreserved=identity)
        if not verified and error is None:
            result["error"] = "native MIDI reversal readback did not match the plan"
    except Exception as failure:
        result["observationError"] = (str(failure) or failure.__class__.__name__)[:600]
    return result
