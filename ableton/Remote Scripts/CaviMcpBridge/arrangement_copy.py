"""Copy one Arrangement passage onto another ordinary track."""
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


def _objects(song, params):
    source_id, target_id, clip_id = params.get("trackId"), params.get("destinationTrackId"), params.get("clipId")
    if any(not isinstance(value, str) or not re.fullmatch(r"track-(?:0|[1-9][0-9]*)", value) for value in (source_id, target_id)):
        raise ValueError("canonical ordinary track IDs required")
    if source_id == target_id:
        raise ValueError("destination must be a different track")
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(source_id) + r":arrangement-clip-(?:0|[1-9][0-9]*)", clip_id):
        raise ValueError("exact Arrangement source clip ID required")
    if len(song.tracks) > 256:
        raise ValueError("Arrangement copying supports at most 256 tracks")
    _, source = _track(song, source_id)
    _, target = _track(song, target_id)
    if any(getattr(owner, "is_foldable", False) for owner in (source, target)):
        raise ValueError("ordinary source and destination tracks required")
    if len(source.arrangement_clips) > 4096 or len(target.arrangement_clips) > 4096:
        raise ValueError("Arrangement copying supports at most 4096 clips per track")
    clip, timeline = _clip_reference(song, source_id, clip_id)
    return source, target, clip, timeline


def _binding(song, objects):
    source, target, clip, _ = objects
    return tuple(song.tracks), source, target, clip, tuple(source.arrangement_clips), tuple(target.arrangement_clips)


def source(song, params, version):
    global _song
    objects = _objects(song, params)
    original, target, clip, timeline = objects
    if len(target.arrangement_clips) >= 4096:
        raise ValueError("destination must have room for a copy within 4096 clips")
    if any(getattr(owner, "is_frozen", False) for owner in (original, target)):
        raise ValueError("resolve frozen tracks before copying")
    if song.record_mode or song.session_record or getattr(song, "is_counting_in", False) or getattr(clip, "is_recording", False):
        raise ValueError("resolve recording and count-in before copying")
    required = "has_audio_input" if getattr(clip, "is_audio_clip", False) else "has_midi_input"
    if getattr(target, required, None) is not True:
        raise ValueError("destination track type cannot accept the source clip")
    start = params.get("startBeats")
    if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
        raise ValueError("finite nonnegative startBeats required")
    end = start + timeline["lengthBeats"]
    if not math.isfinite(end) or end <= start or end > 9007199254740991:
        raise ValueError("copy interval is invalid")
    if any(start < other.end_time and end > other.start_time for other in target.arrangement_clips):
        raise ValueError("destination would overlap an existing Arrangement clip")
    binding = _binding(song, objects)
    if _song != song:
        _song = song
        _identities.clear()
    key = params["trackId"], params["clipId"], params["destinationTrackId"]
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if key not in _identities and len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    result = {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
              "trackId": params["trackId"], "clipId": params["clipId"], "destinationTrackId": params["destinationTrackId"],
              "sourceTrackName": original.name, "destinationTrackName": target.name,
              "source": _content(song, params["trackId"], params["clipId"], version), "timeline": timeline,
              "destinationClips": _arrangement_clips(song, params["destinationTrackId"], version)["clips"],
              "startBeats": start, "endBeats": end}
    if _binding(song, _objects(song, params)) != binding:
        raise ValueError("native source or destination changed during inspection")
    return result


def _comparison(content):
    result = _comparable(content)
    result["timing"] = {key: value for key, value in result["timing"].items() if key != "editorGrid"}
    return result


def duplicate(song, params, version):
    name = params.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("name requires 1 to 128 characters without controls")
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("Arrangement copy source or destination changed; review a fresh plan")
    original, target, clip, _ = _objects(song, params)
    binding = _binding(song, (original, target, clip, None))
    attempted, returned, named, created, error = False, False, False, None, None
    try:
        with _undo_step(song):
            if source(song, params, version) != before or _binding(song, _objects(song, params)) != binding:
                raise ValueError("Arrangement copy context changed before native write")
            attempted = True
            created = target.duplicate_clip_to_arrangement(clip, before["startBeats"])
            returned = True
            if created is None or created == clip or any(created == old for old in binding[5]):
                raise RuntimeError("native copy identity is unconfirmed")
            if tuple(song.tracks) != binding[0] or tuple(item for item in target.arrangement_clips if item != created) != binding[5]:
                raise RuntimeError("destination ownership changed after copying")
            if sum(item == created for item in target.arrangement_clips) != 1:
                raise RuntimeError("native copy is absent or ambiguous")
            created.name = name
            named = True
    except Exception as failure:
        if not attempted:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {"stateVersion": version + 1, "copyRequested": attempted, "nativeReturned": returned,
              "nameWriteReturned": named, "copyVerified": False, "sourcePreserved": False,
              "destinationRetained": False, "copiedClipId": None, "observedCopy": None, "error": error}
    try:
        current_source, current_target, current_clip, current_timeline = _objects(song, params)
        same_tracks = tuple(song.tracks) == binding[0] and current_source == original and current_target == target
        preserved = same_tracks and current_clip == clip and tuple(original.arrangement_clips) == binding[4] and current_timeline == before["timeline"] and _content(song, params["trackId"], params["clipId"], version) == before["source"]
        result["sourcePreserved"] = preserved
        result["destinationClips"] = _arrangement_clips(song, params["destinationTrackId"], version + 1)["clips"]
        if created is None or not returned:
            return result
        candidates = [i for i, item in enumerate(target.arrangement_clips) if item == created]
        retained = same_tracks and len(candidates) == 1 and created != clip and not any(created == old for old in binding[5]) and tuple(item for item in target.arrangement_clips if item != created) == binding[5]
        old_records = [_arrangement_clip_record(item, params["destinationTrackId"], i) for i, item in enumerate(binding[5])]
        retained = retained and old_records == before["destinationClips"]
        result["destinationRetained"] = retained
        if not retained:
            return {**result, "error": error or "destination identity or prior clips changed"}
        copied_id = f'{params["destinationTrackId"]}:arrangement-clip-{candidates[0]}'
        actual = _content(song, params["destinationTrackId"], copied_id, version + 1)
        timeline = _arrangement_clip_record(created, params["destinationTrackId"], candidates[0])
        interval = math.isclose(timeline["startBeats"], before["startBeats"], rel_tol=0, abs_tol=1e-8) and math.isclose(timeline["endBeats"], before["endBeats"], rel_tol=0, abs_tol=1e-8)
        collision = any(other != created and created.start_time < other.end_time and created.end_time > other.start_time for other in target.arrangement_clips)
        verified = error is None and named and preserved and interval and not collision and _comparison(actual) == _comparison({**before["source"], "name": name})
        return {**result, "copyVerified": verified, "copiedClipId": copied_id, "observedCopy": actual, "copiedClip": timeline,
                "error": error if verified or error else "copy content, interval or source readback did not match"}
    except Exception as failure:
        return {**result, "observationError": (str(failure) or failure.__class__.__name__)[:600]}
