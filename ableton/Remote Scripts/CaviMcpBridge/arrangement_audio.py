"""Import local audio directly onto an empty Arrangement audio track."""
import math
import os
import re
import stat
import uuid
try:
    from .bridge import _track, _arrangement_clips, _arrangement_clip_record, _audio_clip_state, _clip_timing, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _track, _arrangement_clips, _arrangement_clip_record, _audio_clip_state, _clip_timing, _set_fingerprint, _undo_step

_song = None
_identities = {}


def _owner(song, params):
    track_id = params.get("trackId")
    if not isinstance(track_id, str) or not re.fullmatch(r"track-(?:0|[1-9][0-9]*)", track_id):
        raise ValueError("canonical ordinary audio track ID required")
    if len(song.tracks) > 256:
        raise ValueError("audio import supports at most 256 tracks")
    _, track = _track(song, track_id)
    if getattr(track, "is_foldable", False) or getattr(track, "has_audio_input", None) is not True:
        raise ValueError("ordinary audio track required")
    return track


def _safe(song, track):
    if getattr(track, "is_frozen", False) or song.record_mode or song.session_record or getattr(song, "is_counting_in", False):
        raise ValueError("resolve frozen tracks, recording and count-in before import")


def target(song, params, version):
    global _song
    track = _owner(song, params)
    _safe(song, track)
    if track.arrangement_clips:
        raise ValueError("direct audio import requires an empty Arrangement track; native span is determined during import")
    if not callable(getattr(track, "create_audio_clip", None)):
        raise ValueError("native Arrangement audio import unavailable")
    start = params.get("startBeats")
    if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or not 0 <= start <= 1576800:
        raise ValueError("startBeats must be within 0 to 1576800")
    binding = tuple(song.tracks), track
    if _song != song:
        _song = song
        _identities.clear()
    key = params["trackId"]
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if key not in _identities and len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    if (_owner(song, params), tuple(song.tracks)) != (track, binding[0]) or track.arrangement_clips:
        raise ValueError("native target changed during inspection")
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": key, "trackName": track.name, "startBeats": start, "clips": []}


def _file(path):
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.realpath(path) != path:
        raise ValueError("canonical absolute sourcePath required")
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("sourcePath must be a regular audio file")
    return {"size": str(info.st_size), "mtimeNs": str(info.st_mtime_ns), "device": str(info.st_dev), "inode": str(info.st_ino)}


def _owned(song, params, binding, created):
    track = _owner(song, params)
    return track == binding[1] and tuple(song.tracks) == binding[0] and created is not None and tuple(track.arrangement_clips) == (created,)


def _ready(song, params, binding, created):
    if not _owned(song, params, binding, created):
        raise ValueError("new audio clip ownership changed")
    _safe(song, binding[1])
    if getattr(created, "is_audio_clip", None) is not True:
        raise ValueError("native audio clip required")
    if not math.isclose(created.start_time, params["startBeats"], rel_tol=0, abs_tol=1e-8) or not math.isfinite(created.end_time) or created.end_time <= created.start_time:
        raise ValueError("native imported interval did not match")
    path = getattr(created, "file_path", None)
    if not isinstance(path, str) or os.path.realpath(path) != params["sourcePath"]:
        raise ValueError("native source reference differs; inspect the retained clip")
    if _file(params["sourcePath"]) != params.get("sourceFile"):
        raise ValueError("source file changed during import")


def create(song, params, version):
    name = params.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("name requires 1 to 128 characters without controls")
    before = target(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("native audio import target changed; review a fresh plan")
    if _file(params.get("sourcePath")) != params.get("sourceFile"):
        raise ValueError("source file changed after planning")
    track = _owner(song, params)
    binding = tuple(song.tracks), track
    attempted, returned, named, created, error = False, False, False, None, None
    try:
        with _undo_step(song):
            if target(song, params, version) != before or _file(params["sourcePath"]) != params["sourceFile"]:
                raise ValueError("audio import target or source changed before native write")
            attempted = True
            native_result = track.create_audio_clip(params["sourcePath"], params["startBeats"])
            returned = True
            if len(track.arrangement_clips) != 1:
                raise ValueError("new audio clip ownership is unconfirmed")
            candidate = track.arrangement_clips[0]
            if native_result is not None and native_result != candidate:
                raise ValueError("native audio result does not match the new clip")
            created = candidate
            _ready(song, params, binding, created)
            created.name = name
            named = True
    except Exception as failure:
        if not attempted:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {"stateVersion": version + 1, "importRequested": attempted, "nativeReturned": returned,
              "nameWriteReturned": named, "importVerified": False, "targetRetained": False,
              "sourceMetadataUnchanged": False, "sourceReferenceMatched": False,
              "createdClipId": None, "observedClip": None, "audioState": None, "error": error}
    try:
        result["sourceMetadataUnchanged"] = _file(params["sourcePath"]) == params["sourceFile"]
    except (OSError, ValueError) as failure:
        result["sourceObservationError"] = str(failure)[:600]
    try:
        result["clips"] = _arrangement_clips(song, params["trackId"], version + 1)["clips"]
        retained = _owned(song, params, binding, created)
        result["targetRetained"] = retained
        if not returned or not retained:
            return {**result, "error": error or "new clip ownership is unconfirmed"}
        clip_id = params["trackId"] + ":arrangement-clip-0"
        observed = _arrangement_clip_record(created, params["trackId"], 0)
        audio = _audio_clip_state(song, params["trackId"], clip_id, version + 1)
        path = audio["source"]["path"]
        matched = isinstance(path, str) and os.path.realpath(path) == params["sourcePath"]
        interval = math.isclose(observed["startBeats"], params["startBeats"], rel_tol=0, abs_tol=1e-8) and math.isfinite(observed["endBeats"]) and observed["endBeats"] > observed["startBeats"]
        timing = _clip_timing(song, params["trackId"], clip_id, version + 1)
        verified = error is None and named and result["sourceMetadataUnchanged"] and matched and interval and observed["name"] == name and _owned(song, params, binding, created)
        return {**result, "sourceReferenceMatched": matched, "importVerified": verified, "createdClipId": clip_id,
                "observedClip": observed, "audioState": audio, "observedTiming": timing,
                "error": error if verified or error else "audio import readback did not match"}
    except Exception as failure:
        return {**result, "observationError": (str(failure) or failure.__class__.__name__)[:600]}
