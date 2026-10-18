"""Request one guarded native locator jump without controlling playback."""
import math
import re
import uuid

_song = None
_identities = {}


def _finite(value):
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError("finite nonnegative locator and transport positions required")
    return result


def _objects(song, params):
    cue_id = params.get("cuePointId")
    if not isinstance(cue_id, str) or not re.fullmatch(r"cue-(?:0|[1-9][0-9]*)", cue_id):
        raise ValueError("canonical cue point ID required")
    cues = tuple(song.cue_points)
    if len(cues) > 4096:
        raise ValueError("locator jumps support at most 4096 cue points")
    index = int(cue_id[4:])
    if index >= len(cues):
        raise ValueError("unknown cue point")
    return cues[index], cues


def _safe(song):
    for flag in ("record_mode", "session_record", "is_counting_in"):
        if getattr(song, flag, None) is not False:
            raise ValueError("recording and count-in must be known inactive before a locator jump")
    tracks = tuple(song.tracks)
    if len(tracks) > 256:
        raise ValueError("locator recording inspection exceeds 256 tracks")
    count = 0
    for track in tracks:
        if getattr(track, "is_foldable", False):
            continue
        slots = tuple(track.clip_slots)
        arrangement = tuple(track.arrangement_clips)
        count += len(slots) + len(arrangement)
        if count > 16384:
            raise ValueError("locator recording inspection exceeds its clip bound")
        clips = [slot.clip for slot in slots if slot.has_clip] + list(arrangement)
        if any(getattr(clip, "is_recording", None) is not False for clip in clips):
            raise ValueError("clip recording must be known inactive before a locator jump")


def context(song, params, version):
    global _song
    _safe(song)
    cue, cues = _objects(song, params)
    binding = cues, cue
    if _song != song:
        _song = song
        _identities.clear()
    key = params["cuePointId"]
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if key not in _identities and len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    playing = bool(song.is_playing)
    result = {"stateVersion":version, "cuePointId":key, "identityToken":cached[1],
              "cuePoint":{"id":key, "name":cue.name, "timeBeats":_finite(cue.time)},
              "transport":{"isPlaying":playing, "clipTriggerQuantization":int(song.clip_trigger_quantization),
                           "loop":bool(song.loop), "loopStart":_finite(song.loop_start), "loopLength":_finite(song.loop_length)}}
    if not playing:
        result["transport"]["currentSongTime"] = _finite(song.current_song_time)
    if _objects(song, params) != (cue, cues):
        raise ValueError("cue point changed during inspection")
    return result


def begin(song, params, version):
    before = context(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("cue point or transport changed; review a fresh plan")
    cue, cues = _objects(song, params)
    if context(song, params, version) != before or _objects(song, params) != (cue, cues):
        raise ValueError("cue point changed before jump")
    returned, error = False, None
    try:
        cue.jump()
        returned = True
    except Exception as failure:
        error = (str(failure) or failure.__class__.__name__)[:600]
    return {"before":before, "song":song, "cue":cue, "cues":cues, "nativeReturned":returned, "error":error}


def _receipt(operation, version):
    before = operation["before"]
    return {"stateVersion":version, "cuePoint":before["cuePoint"], "jumpRequested":True,
            "nativeReturned":operation["nativeReturned"], "positionVerified":False, "targetRetained":False,
            "playbackStatePreserved":False, "arrivalMayBeQuantized":before["transport"]["isPlaying"],
            "observed":None, "error":operation["error"],
            "limitation":"Playing jumps may be quantized; a returned request is not verified arrival or audible Arrangement playback. No automatic replay or rollback."}


def unobserved(operation, version, error):
    return {**_receipt(operation, version), "observationError":(str(error) or error.__class__.__name__)[:600]}


def complete(song, operation, version):
    before, cue, cues = operation["before"], operation["cue"], operation["cues"]
    params = {"cuePointId":before["cuePointId"]}
    result = _receipt(operation, version)
    try:
        after = context(song, params, version)
        position = _finite(song.current_song_time)
        retained = song == operation["song"] and _objects(song, params) == (cue, cues) and after["cuePoint"] == before["cuePoint"]
        playback = after["transport"]["isPlaying"] == before["transport"]["isPlaying"]
        verified = operation["nativeReturned"] and operation["error"] is None and retained and playback and not before["transport"]["isPlaying"] and abs(position-before["cuePoint"]["timeBeats"]) <= 1e-6
        result.update(targetRetained=retained, playbackStatePreserved=playback, positionVerified=verified,
                      observed={"currentSongTime":position, "context":after})
    except Exception as failure:
        result["observationError"] = (str(failure) or failure.__class__.__name__)[:600]
    return result


def jump(song, params, version):
    return complete(song, begin(song, params, version), version+1)
