"""Guard whole-clip deletion in Session and Arrangement."""
import re
import uuid
try:
    from .bridge import _track, _clip_slot, _clip_reference, _clip_list, _arrangement_clips, _arrangement_clip_record, _set_fingerprint, _undo_step
    from .clip_duplication import _content
except ImportError:
    from bridge import _track, _clip_slot, _clip_reference, _clip_list, _arrangement_clips, _arrangement_clip_record, _set_fingerprint, _undo_step
    from clip_duplication import _content

_song = None
_identities = {}


def _objects(song, params):
    track_id, clip_id, location = params.get("trackId"), params.get("clipId"), params.get("location")
    if not isinstance(track_id, str) or not re.fullmatch(r"track-(?:0|[1-9][0-9]*)", track_id):
        raise ValueError("canonical ordinary track ID required")
    if location not in ("session", "arrangement"):
        raise ValueError("exact session or arrangement location required")
    prefix = ":clip-" if location == "session" else ":arrangement-clip-"
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id + prefix) + r"(?:0|[1-9][0-9]*)", clip_id):
        raise ValueError("canonical clip ID for the requested location required")
    if len(song.tracks) > 256:
        raise ValueError("clip removal supports at most 256 tracks")
    _, track = _track(song, track_id)
    if getattr(track, "is_foldable", False) or getattr(track, "is_frozen", False):
        raise ValueError("an unfrozen ordinary track is required")
    slot, index = None, int(clip_id.split(prefix)[1])
    if location == "session":
        if len(track.clip_slots) > 4096 or len(song.scenes) > 4096:
            raise ValueError("clip removal supports at most 4096 Session slots and scenes")
        _, index, slot = _clip_slot(song, track_id, clip_id)
        if not slot.has_clip:
            raise ValueError("clip is empty")
        clip = slot.clip
    else:
        if len(track.arrangement_clips) > 4096:
            raise ValueError("clip removal supports at most 4096 Arrangement clips")
        clip, _ = _clip_reference(song, track_id, clip_id)
    if song.record_mode or song.session_record or getattr(song, "is_counting_in", False) or getattr(clip, "is_recording", False):
        raise ValueError("resolve recording and count-in before removal")
    if getattr(slot, "is_triggered", False) or getattr(clip, "is_triggered", False):
        raise ValueError("resolve pending launches before removal")
    return track, clip, slot, index


def _binding(song, params, objects):
    track, clip, slot, index = objects
    session = params["location"] == "session"
    slots = tuple(track.clip_slots) if session else None
    clips = tuple(item.clip if item.has_clip else None for item in slots) if session else tuple(track.arrangement_clips)
    return {"tracks": tuple(song.tracks), "scenes": tuple(song.scenes) if session else None,
            "track": track, "slots": slots, "source": clip, "clips": clips, "sourceIndex": index}


def _inventory(song, params, version):
    return (_clip_list if params["location"] == "session" else _arrangement_clips)(song, params["trackId"], version)["clips"]


def source(song, params, version):
    global _song
    objects = _objects(song, params)
    track, clip, slot, index = objects
    binding = _binding(song, params, objects)
    if _song != song:
        _song = song
        _identities.clear()
    key = params["trackId"], params["clipId"], params["location"]
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if key not in _identities and len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    clips = _inventory(song, params, version)
    result = {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
              "trackId": params["trackId"], "clipId": params["clipId"], "location": params["location"],
              "trackName": track.name, "sceneName": song.scenes[index].name if slot is not None else None,
              "transportPlaying": bool(getattr(song, "is_playing", False)),
              "target": clips[index], "clips": clips,
              "source": _content(song, params["trackId"], params["clipId"], version),
              "scope": {"wholeClip": True, "includesClipEnvelopesAndNoteExpression": True, "restorableSnapshot": False},
              "warning": "Deletes the entire native clip, including clip envelopes and note expression. Hidden contents and edits are not compared; the exposed snapshot is not a restorable backup."}
    if _binding(song, params, _objects(song, params)) != binding or result["transportPlaying"] != bool(getattr(song, "is_playing", False)):
        raise ValueError("native clip removal context changed during inspection")
    return result


def _owners(song, params, binding):
    if tuple(song.tracks) != binding["tracks"] or _track(song, params["trackId"])[1] != binding["track"]:
        return False
    if binding["slots"] is not None:
        return tuple(song.scenes) == binding["scenes"] and tuple(binding["track"].clip_slots) == binding["slots"]
    return True


def remove(song, params, version):
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("clip removal source or layout changed; review a fresh plan")
    objects = _objects(song, params)
    track, clip, slot, index = objects
    binding = _binding(song, params, objects)
    requested, returned, error = False, False, None
    try:
        with _undo_step(song):
            if source(song, params, version) != before or _binding(song, params, _objects(song, params)) != binding:
                raise ValueError("clip removal context changed before native deletion")
            requested = True
            if slot is not None:
                slot.delete_clip()
            else:
                track.delete_clip(clip)
            returned = True
    except Exception as failure:
        if not requested:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {"stateVersion": version + 1, "trackId": params["trackId"], "location": params["location"],
              "deletionRequested": requested, "nativeReturned": returned, "deletionVerified": False,
              "targetCleared": None, "ownerRetained": False, "otherClipsRetained": False,
              "previousClip": before["target"], "error": error,
              "limitation": "Verifies target clearance and remaining native clip identities and exposed metadata on the intended track. Other clip contents, hidden state, clip envelopes, note expression and external file bytes are not compared. No automatic reconstruction or replay."}
    try:
        result["clips"] = _inventory(song, params, version + 1)
        result["ownerRetained"] = _owners(song, params, binding)
        result["transportPlaying"] = bool(getattr(song, "is_playing", False))
        if not result["ownerRetained"]:
            return {**result, "error": error or "native clip owner changed; inspect current inventory"}
        # The removed native object can be invalid and non-reflexive. Exclude its captured index.
        expected = tuple(item for i, item in enumerate(binding["clips"]) if i != index)
        if slot is not None:
            current = tuple(item.clip if item.has_clip else None for item in track.clip_slots)
            result["targetCleared"] = not slot.has_clip
            retained = tuple(item for i, item in enumerate(current) if i != index) == expected
            retained = retained and [item for i, item in enumerate(result["clips"]) if i != index] == [item for i, item in enumerate(before["clips"]) if i != index]
        else:
            current = tuple(track.arrangement_clips)
            result["targetCleared"] = not any(item == clip for item in current)
            remaining = current if result["targetCleared"] else tuple(item for item in current if item != clip)
            retained = remaining == expected
            retained = retained and all(_arrangement_clip_record(item, params["trackId"], i) == before["clips"][i]
                                        for i, item in enumerate(binding["clips"]) if i != index)
        result["ownerRetained"] = _owners(song, params, binding)
        if not result["ownerRetained"]:
            result["targetCleared"] = None
        result["otherClipsRetained"] = retained and result["ownerRetained"]
        result["deletionVerified"] = error is None and returned and result["targetCleared"] and result["otherClipsRetained"]
        if result["deletionVerified"]:
            result["deletedClip"] = before["target"]
            if "target" in params:
                result["deleted"] = {"targetType": "clip", "trackId": params["trackId"], "targetId": params["clipId"], "name": before["source"]["name"]}
        elif error is None:
            result["error"] = "native deletion readback did not match"
    except Exception as failure:
        result["deletionVerified"] = False
        result["targetCleared"] = None
        result["ownerRetained"] = False
        result["otherClipsRetained"] = False
        result["observationError"] = (str(failure) or failure.__class__.__name__)[:600]
    return result
