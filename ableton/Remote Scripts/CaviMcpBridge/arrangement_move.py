"""Move one Arrangement clip through verified native staging copies."""
import math
import re
import uuid
try:
    from .bridge import _track, _clip_reference, _arrangement_clip_record, _arrangement_clips, _set_fingerprint, _undo_step
    from .clip_duplication import _content, _comparable
except ImportError:
    from bridge import _track, _clip_reference, _arrangement_clip_record, _arrangement_clips, _set_fingerprint, _undo_step
    from clip_duplication import _content, _comparable

_song = None
_identities = {}


def _safe(song, track, clip=None):
    if getattr(track, "is_frozen", False) or getattr(track, "is_foldable", False):
        raise ValueError("an unfrozen ordinary track is required")
    if song.record_mode or song.session_record or getattr(song, "is_counting_in", False) or getattr(clip, "is_recording", False):
        raise ValueError("resolve recording and count-in before moving")


def _objects(song, params):
    track_id, clip_id = params.get("trackId"), params.get("clipId")
    if not isinstance(track_id, str) or not re.fullmatch(r"track-(?:0|[1-9][0-9]*)", track_id):
        raise ValueError("canonical ordinary track ID required")
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id) + r":arrangement-clip-(?:0|[1-9][0-9]*)", clip_id):
        raise ValueError("exact Arrangement clip ID required")
    if len(song.tracks) > 256:
        raise ValueError("Arrangement moves support at most 256 tracks")
    _, track = _track(song, track_id)
    if len(track.arrangement_clips) > 4096:
        raise ValueError("Arrangement moves support at most 4096 clips")
    clip, timeline = _clip_reference(song, track_id, clip_id)
    _safe(song, track, clip)
    return track, clip, timeline


def _binding(song, track, clip):
    return tuple(song.tracks), track, clip, tuple(track.arrangement_clips)


def _empty(track, start, end, ignored=None):
    if any(other != ignored and start < other.end_time and end > other.start_time for other in track.arrangement_clips):
        raise ValueError("move would overlap another Arrangement clip")


def source(song, params, version):
    global _song
    track, clip, timeline = _objects(song, params)
    start = params.get("startBeats")
    if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
        raise ValueError("finite nonnegative startBeats required")
    end = start + timeline["lengthBeats"]
    if not math.isfinite(end) or end <= start or end > 9007199254740991:
        raise ValueError("move interval is invalid")
    _empty(track, start, end, clip)
    staging = None
    if start != timeline["startBeats"]:
        if len(track.arrangement_clips) > 4095:
            raise ValueError("a move requires at most 4095 clips to reserve staging capacity")
        staging = max(end, *(float(other.end_time) for other in track.arrangement_clips)) + 1
        staging_end = staging + timeline["lengthBeats"]
        if not math.isfinite(staging_end) or staging_end <= staging or staging_end > 9007199254740991:
            raise ValueError("staging interval is invalid")
    binding = _binding(song, track, clip)
    if _song != song:
        _song = song
        _identities.clear()
    key = params["trackId"], params["clipId"]
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if key not in _identities and len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    result = {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
              "trackId": params["trackId"], "clipId": params["clipId"], "trackName": track.name,
              "timeline": timeline, "source": _content(song, params["trackId"], params["clipId"], version),
              "clips": _arrangement_clips(song, params["trackId"], version)["clips"],
              "startBeats": start, "endBeats": end, "stagingStartBeats": staging,
              "stagingEndBeats": None if staging is None else staging + timeline["lengthBeats"]}
    current_track, current_clip, _ = _objects(song, params)
    if _binding(song, current_track, current_clip) != binding:
        raise ValueError("native move source or layout changed during inspection")
    return result


def _read(song, track_id, track, clip, version):
    layout = tuple(track.arrangement_clips)
    indices = [i for i, item in enumerate(layout) if item == clip]
    if len(indices) != 1:
        raise RuntimeError("native clip is absent or ambiguous")
    index = indices[0]
    content = _content(song, track_id, f"{track_id}:arrangement-clip-{index}", version)
    timeline = _arrangement_clip_record(clip, track_id, index)
    if _track(song, track_id)[1] != track or tuple(track.arrangement_clips) != layout:
        raise RuntimeError("native clip ownership changed during readback")
    return timeline, content


def _comparison(content):
    result = _comparable(content)
    result["timing"] = {key: value for key, value in result["timing"].items() if key != "editorGrid"}
    return result


def _layout(song, params, binding, before, removed, extras):
    track, original = binding[1], binding[2]
    if tuple(song.tracks) != binding[0] or _track(song, params["trackId"])[1] != track:
        raise RuntimeError("native track ownership changed")
    expected = tuple(item for item in binding[3] if not removed or item != original)
    if any(extra is None or any(extra == old for old in binding[3]) or sum(item == extra for item in track.arrangement_clips) != 1 for extra in extras):
        raise RuntimeError("native copy ownership is unconfirmed")
    if len(extras) == 2 and extras[0] == extras[1]:
        raise RuntimeError("native staging and destination identities must differ")
    if tuple(item for item in track.arrangement_clips if not any(item == extra for extra in extras)) != expected:
        raise RuntimeError("prior native clip layout changed")
    for i, old in enumerate(binding[3]):
        if not removed or old != original:
            if _arrangement_clip_record(old, params["trackId"], i) != before["clips"][i]:
                raise RuntimeError("prior Arrangement clip interval or name changed")
    _safe(song, track)


def _copy(song, params, binding, before, clip, start, version):
    timeline, content = _read(song, params["trackId"], binding[1], clip, version)
    if not math.isclose(timeline["startBeats"], start, rel_tol=0, abs_tol=1e-8) or not math.isclose(timeline["endBeats"], start + before["timeline"]["lengthBeats"], rel_tol=0, abs_tol=1e-8):
        raise RuntimeError("native copy interval did not match")
    if _comparison(content) != _comparison(before["source"]):
        raise RuntimeError("native copy content did not match")
    _empty(binding[1], timeline["startBeats"], timeline["endBeats"], clip)
    return timeline, content


def _stable_pair(song, params, binding, before, first, second, version):
    observations = {}
    # Inspect both orders. A later content read must not invalidate a checked copy.
    for item, start in (first, second, second, first):
        if item == binding[2]:
            timeline, content = _read(song, params["trackId"], binding[1], item, version)
            if content != before["source"] or {**timeline, "id": before["timeline"]["id"]} != before["timeline"]:
                raise RuntimeError("original source changed before removal")
        else:
            timeline, content = _copy(song, params, binding, before, item, start, version)
        key = "first" if item == first[0] else "second"
        current = timeline, content
        if key in observations and observations[key] != current:
            raise RuntimeError("paired clip content changed before removal")
        observations[key] = current


def move(song, params, version):
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("Arrangement move source or destination changed; review a fresh plan")
    track, original, _ = _objects(song, params)
    binding = _binding(song, track, original)
    result = {"stateVersion": version, "moveRequested": False, "stagingCopyReturned": False,
              "sourceRemovalRequested": False, "sourceRemovalReturned": False,
              "destinationCopyRequested": False, "destinationCopyReturned": False,
              "stagingRemovalRequested": False, "stagingRemovalReturned": False,
              "moveVerified": False, "sourceRetained": None, "sourcePreserved": False,
              "existingIntervalsPreserved": False, "stagingClip": None, "movedClip": None,
              "observedDestination": None, "previousClip": before["timeline"], "error": None,
              "limitation": "Verifies exposed MIDI notes, timing, audio settings and prior native clip identities/intervals. Hidden state, clip-envelope contents or retargeting, external sample bytes and audible equivalence are not compared. Audio copies share the source file."}
    if before["stagingStartBeats"] is None:
        return {**result, "moveVerified": True, "sourceRetained": True, "sourcePreserved": True,
                "existingIntervalsPreserved": True, "movedClip": before["timeline"], "clips": before["clips"]}
    staged = destination = None
    try:
        with _undo_step(song):
            if source(song, params, version) != before or _binding(song, *_objects(song, params)[:2]) != binding:
                raise ValueError("Arrangement move context changed before native staging")
            result["moveRequested"] = True
            staged = track.duplicate_clip_to_arrangement(original, before["stagingStartBeats"])
            result["stagingCopyReturned"] = True
            _layout(song, params, binding, before, False, [staged])
            _stable_pair(song, params, binding, before, (staged, before["stagingStartBeats"]),
                         (original, before["timeline"]["startBeats"]), version)
            _layout(song, params, binding, before, False, [staged])
            _safe(song, track, original)
            _empty(track, before["startBeats"], before["endBeats"], original)
            result["sourceRemovalRequested"] = True
            track.delete_clip(original)
            result["sourceRemovalReturned"] = True
            _layout(song, params, binding, before, True, [staged])
            _copy(song, params, binding, before, staged, before["stagingStartBeats"], version)
            _layout(song, params, binding, before, True, [staged])
            _empty(track, before["startBeats"], before["endBeats"])
            result["destinationCopyRequested"] = True
            destination = track.duplicate_clip_to_arrangement(staged, before["startBeats"])
            result["destinationCopyReturned"] = True
            _layout(song, params, binding, before, True, [staged, destination])
            _stable_pair(song, params, binding, before, (staged, before["stagingStartBeats"]),
                         (destination, before["startBeats"]), version)
            _layout(song, params, binding, before, True, [staged, destination])
            result["stagingRemovalRequested"] = True
            track.delete_clip(staged)
            result["stagingRemovalReturned"] = True
    except Exception as failure:
        if not result["moveRequested"]:
            raise
        result["error"] = (str(failure) or failure.__class__.__name__)[:600]
    result["stateVersion"] = version + 1
    try:
        if tuple(song.tracks) != binding[0] or _track(song, params["trackId"])[1] != track:
            raise RuntimeError("native track ownership changed during observation")
        source_present = any(item == original for item in track.arrangement_clips)
        if source_present:
            timeline, content = _read(song, params["trackId"], track, original, version + 1)
            result["sourceClip"] = timeline
            result["sourcePreserved"] = content == before["source"] and {**timeline, "id": before["timeline"]["id"]} == before["timeline"]
        stage_present = staged is not None and any(item == staged for item in track.arrangement_clips)
        if stage_present:
            result["stagingClip"], result["observedStaging"] = _read(song, params["trackId"], track, staged, version + 1)
        destination_present = destination is not None and any(item == destination for item in track.arrangement_clips)
        matched = False
        if destination_present:
            result["movedClip"], result["observedDestination"] = _read(song, params["trackId"], track, destination, version + 1)
            timeline, content = result["movedClip"], result["observedDestination"]
            matched = math.isclose(timeline["startBeats"], before["startBeats"], rel_tol=0, abs_tol=1e-8) and math.isclose(timeline["endBeats"], before["endBeats"], rel_tol=0, abs_tol=1e-8) and _comparison(content) == _comparison(before["source"])
        result["sourceRetained"] = source_present
        result["clips"] = _arrangement_clips(song, params["trackId"], version + 1)["clips"]
        extras = ([staged] if stage_present else []) + ([destination] if destination_present else [])
        _layout(song, params, binding, before, not source_present, extras)
        result["existingIntervalsPreserved"] = True
        result["moveVerified"] = result["error"] is None and all(result[key] for key in ("stagingCopyReturned", "sourceRemovalReturned", "destinationCopyReturned", "stagingRemovalReturned")) and not source_present and not stage_present and matched
        if not result["moveVerified"] and result["error"] is None:
            result["error"] = "move content, ownership or completion readback did not match"
    except Exception as failure:
        result["moveVerified"] = False
        result["sourceRetained"] = None
        result["sourcePreserved"] = False
        result["existingIntervalsPreserved"] = False
        result["observationError"] = (str(failure) or failure.__class__.__name__)[:600]
    return result
