"""Guarded native Session copies for audio and MIDI development."""
import json
import re
import uuid

try:
    from .bridge import _clip_slot, _clip_reference, _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint, _undo_step, _clip_list
except ImportError:
    from bridge import _clip_slot, _clip_reference, _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint, _undo_step, _clip_list

_song = None
_identities = {}


def _objects(song, params):
    target_track_id = params.get("targetTrackId", params["trackId"])
    for track_id, clip_id in ((params["trackId"], params["sourceClipId"]), (target_track_id, params["targetClipId"])):
        if not isinstance(track_id, str) or not re.fullmatch(r"track-(?:0|[1-9][0-9]*)", track_id):
            raise ValueError("canonical ordinary track ID required")
        if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id + ":clip-") + r"(?:0|[1-9][0-9]*)", clip_id):
            raise ValueError("canonical Session clip ID required")
    if len(song.tracks) > 256 or len(song.scenes) > 4096:
        raise ValueError("clip duplication supports at most 256 tracks and 4096 scenes")
    source_track, _, original = _clip_slot(song, params["trackId"], params["sourceClipId"])
    target_track, _, target = _clip_slot(song, target_track_id, params["targetClipId"])
    if max(len(source_track.clip_slots), len(target_track.clip_slots)) > 4096:
        raise ValueError("clip duplication supports at most 4096 slots per track")
    return source_track, target_track, original, target


def _owners(song, objects):
    source_track, target_track, original, target = objects
    return tuple(song.tracks), tuple(song.scenes), source_track, target_track, tuple(source_track.clip_slots), tuple(target_track.clip_slots)


def _clips(track):
    return tuple(slot.clip if slot.has_clip else None for slot in track.clip_slots)


def _identity(song, objects):
    return _owners(song, objects), objects[2].clip, _clips(objects[0]), _clips(objects[1])


def _safety(song, objects, empty=True):
    track, target_track, original, target = objects
    if original == target or not original.has_clip:
        raise ValueError("source must be occupied and differ from target")
    if empty and target.has_clip:
        raise ValueError("target clip must be empty")
    if any(getattr(owner, "is_frozen", False) or getattr(owner, "is_foldable", False) for owner in (track, target_track)):
        raise ValueError("unfrozen ordinary audio or MIDI tracks required")
    if track != target_track:
        required_input = "has_audio_input" if bool(getattr(original.clip, "is_audio_clip", False)) else "has_midi_input"
        if getattr(target_track, required_input, None) is not True:
            raise ValueError("destination track type does not accept the source clip kind")
    if song.record_mode or song.session_record or getattr(song, "is_counting_in", False) or getattr(original.clip, "is_recording", False):
        raise ValueError("resolve recording and count-in before copying")
    if any(getattr(slot, "is_triggered", False) for slot in (original, target)) or getattr(original.clip, "is_triggered", False):
        raise ValueError("resolve pending source or destination launches before copying")


def _content(song, track_id, clip_id, version):
    clip, _ = _clip_reference(song, track_id, clip_id)
    timing = _clip_timing(song, track_id, clip_id, version)
    for key in ("stateVersion", "trackId", "clipId", "location", "timeline"):
        timing.pop(key, None)
    audio = bool(getattr(clip, "is_audio_clip", False))
    result = {"kind": "audio" if audio else "midi", "name": clip.name,
              "color": getattr(clip, "color", None), "timing": timing}
    if audio:
        if len(getattr(clip, "warp_markers", ())) > 4096:
            raise ValueError("clip duplication supports at most 4096 warp markers")
        state = _audio_clip_state(song, track_id, clip_id, version)
        for key in ("stateVersion", "trackId", "clipId", "location", "timeline"):
            state.pop(key, None)
        result["audio"] = state
    else:
        notes = list(clip.get_all_notes_extended())
        if len(notes) > 4096:
            raise ValueError("clip duplication supports at most 4096 MIDI notes")
        result["notes"] = sorted([_midi_note_record(note) for note in notes], key=lambda note: note["noteId"])
    return result


def source(song, params, version):
    global _song
    track_id, target_track_id = params["trackId"], params.get("targetTrackId", params["trackId"])
    objects = _objects(song, params)
    track, target_track, original, target = objects
    _safety(song, objects)
    if _song != song:
        _song = song
        _identities.clear()
    key = (track_id, params["sourceClipId"], target_track_id, params["targetClipId"])
    identity = _identity(song, objects)
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    result = {"stateVersion": version, "copyGuardVersion": 2, "setFingerprint": _set_fingerprint(song), "trackId": track_id,
            "sourceClipId": params["sourceClipId"], "targetClipId": params["targetClipId"], "targetTrackId": target_track_id,
            "sourceTrackName": track.name, "targetTrackName": target_track.name,
            "identityToken": cached[1], "source": _content(song, track_id, params["sourceClipId"], version),
            "target": {"id": params["targetClipId"], "hasClip": False},
            "sourceClips": _clip_list(song, track_id, version)["clips"],
            "targetClips": _clip_list(song, target_track_id, version)["clips"]}
    _safety(song, _objects(song, params))
    if _identity(song, _objects(song, params)) != identity:
        raise ValueError("clip duplication layout changed during inspection")
    return result


def _comparable(content):
    result = dict(content)
    if "notes" in result:
        result["notes"] = sorted([{key: value for key, value in note.items() if key != "noteId"}
                                  for note in result["notes"]], key=lambda note: json.dumps(note, sort_keys=True))
    return result


def _layout_retained(song, params, identity):
    objects = _objects(song, params)
    if _owners(song, objects) != identity[0] or objects[2].clip != identity[1]:
        return False
    target = objects[3]
    for track, expected in zip(objects[:2], identity[2:]):
        for slot, previous in zip(track.clip_slots, expected):
            if slot != target and (slot.clip if slot.has_clip else None) != previous:
                return False
    return True


def _observe(song, params, version, before, identity, created):
    track_id, target_track_id = params["trackId"], params.get("targetTrackId", params["trackId"])
    source_clips = _clip_list(song, track_id, version)["clips"]
    target_clips = _clip_list(song, target_track_id, version)["clips"]
    objects = _objects(song, params)
    owner_retained = _owners(song, objects) == identity[0]
    if not owner_retained:
        return {"targetRetained": False, "targetOccupied": None, "sourcePreserved": False,
                "copyIdentityRetained": False, "otherClipsRetained": False, "clips": target_clips}
    target = objects[3]
    # Read both directions: a later reader must not invalidate an earlier observation.
    source_before = _content(song, track_id, params["sourceClipId"], version)
    copied = _content(song, target_track_id, params["targetClipId"], version) if target.has_clip else None
    copied_again = _content(song, target_track_id, params["targetClipId"], version) if target.has_clip else None
    source_after = _content(song, track_id, params["sourceClipId"], version)
    source_clips = _clip_list(song, track_id, version)["clips"]
    target_clips = _clip_list(song, target_track_id, version)["clips"]
    objects = _objects(song, params)
    owner_retained = _owners(song, objects) == identity[0]
    layout_retained = owner_retained and _layout_retained(song, params, identity)
    def retained(current, previous):
        return [item for item in current if item["id"] != params["targetClipId"]] == [item for item in previous if item["id"] != params["targetClipId"]]
    source_preserved = layout_retained and source_before == source_after == before["source"]
    result = {"targetRetained": owner_retained, "targetOccupied": bool(target.has_clip) if owner_retained else None,
              "sourcePreserved": source_preserved,
              "copyIdentityRetained": owner_retained and created is not None and target.has_clip and target.clip == created,
              "otherClipsRetained": layout_retained and retained(source_clips, before["sourceClips"]) and retained(target_clips, before["targetClips"]),
              "clips": target_clips, "observedSource": source_after, "observedCopy": copied_again,
              "copyReadbackStable": copied == copied_again}
    _safety(song, objects, empty=False)
    return result


def duplicate(song, params, version):
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version:
        raise ValueError("clip duplication state version changed")
    before = source(song, params, version)
    if before != params.get("before"):
        raise ValueError("clip duplication source or destination changed; review a fresh plan")
    name = params.get("name", before["source"]["name"])
    if "name" in params and (not isinstance(name, str) or not name.strip() or len(name) > 128):
        raise ValueError("name must contain 1 to 128 characters")
    track_id, target_track_id = params["trackId"], params.get("targetTrackId", params["trackId"])
    objects = _objects(song, params)
    _, _, original, target = objects
    identity, created = _identity(song, objects), None
    requested, returned, name_requested, name_returned, error = False, False, False, False, None
    try:
        with _undo_step(song):
            if source(song, params, version) != before or _identity(song, _objects(song, params)) != identity:
                raise ValueError("clip duplication context changed before native copy")
            requested = True
            original.duplicate_clip_to(target)
            returned = True
            if not _layout_retained(song, params, identity) or not target.has_clip or target.clip == original.clip:
                raise RuntimeError("clip copy ownership is unconfirmed; native topology changed or copy is absent")
            created = target.clip
            observed = _observe(song, params, version, before, identity, created)
            if not all(observed[key] for key in ("sourcePreserved", "targetRetained", "copyIdentityRetained", "otherClipsRetained", "copyReadbackStable")) or _comparable(observed["observedCopy"]) != _comparable(before["source"]):
                raise RuntimeError("clip copy readback mismatch before naming")
            if "name" in params:
                name_requested = True
                created.name = name
                name_returned = True
    except Exception as failure:
        if not requested:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {"stateVersion": version + 1, "trackId": target_track_id, "sourceTrackId": track_id,
            "sourceClipId": params["sourceClipId"], "copiedClipId": params["targetClipId"],
            "copyRequested": requested, "nativeReturned": returned, "nameWriteRequested": name_requested, "nameWriteReturned": name_returned,
            "copyVerified": False, "targetRetained": False, "targetOccupied": None, "sourcePreserved": False,
            "copyIdentityRetained": False, "otherClipsRetained": False, "error": error,
            "limitation": "Verifies exposed source/copy content and remaining native clip identities/metadata on both tracks. Hidden state, envelopes/retargeting, other clip contents, processing and external file bytes are not compared. Audio shares its file. No automatic cleanup or replay."}
    try:
        result.update(_observe(song, params, version + 1, before, identity, created))
        result["copyVerified"] = bool(error is None and returned and (not name_requested or name_returned) and
            all(result[key] for key in ("sourcePreserved", "targetRetained", "copyIdentityRetained", "otherClipsRetained", "copyReadbackStable")) and
            _comparable(result["observedCopy"]) == _comparable({**before["source"], "name": name}))
        if not result["copyVerified"] and error is None:
            result["error"] = "clip copy readback mismatch"
    except Exception as failure:
        result.update(copyVerified=False, targetRetained=False, targetOccupied=None, sourcePreserved=False,
                      copyIdentityRetained=False, otherClipsRetained=False, observationError=(str(failure) or failure.__class__.__name__)[:600])
    if "target" in params:
        result["target"] = params["target"]
    return result
