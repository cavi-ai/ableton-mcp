"""Guarded native Session copies for audio and MIDI development."""
import json
import uuid

try:
    from .bridge import _clip_slot, _clip_reference, _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint, _undo_step, _clip_list
except ImportError:
    from bridge import _clip_slot, _clip_reference, _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint, _undo_step, _clip_list

_song = None
_identities = {}


def _objects(song, params):
    source_track, _, original = _clip_slot(song, params["trackId"], params["sourceClipId"])
    target_track, _, target = _clip_slot(song, params.get("targetTrackId", params["trackId"]), params["targetClipId"])
    return source_track, target_track, original, target


def _identity(song, objects):
    source_track, target_track, original, target = objects
    return tuple(song.tracks), source_track, target_track, original, original.clip, target


def _same(song, params, identity):
    try:
        return _identity(song, _objects(song, params)) == identity
    except (ValueError, RuntimeError):
        return False


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
    if original == target:
        raise ValueError("source and target clips must differ")
    if not original.has_clip:
        raise ValueError("source clip is empty")
    if target.has_clip:
        raise ValueError("target clip must be empty")
    if any(bool(getattr(owner, "is_frozen", False)) for owner in (track, target_track)):
        raise ValueError("clip duplication is unavailable on a frozen track")
    if bool(getattr(target_track, "is_foldable", False)):
        raise ValueError("destination must be an ordinary audio or MIDI track")
    if target_track_id != track_id:
        required_input = "has_audio_input" if bool(getattr(original.clip, "is_audio_clip", False)) else "has_midi_input"
        if getattr(target_track, required_input, None) is not True:
            raise ValueError("destination track type does not accept the source clip kind")
    if song.record_mode or song.session_record or bool(getattr(original.clip, "is_recording", False)):
        raise ValueError("resolve recording before copying a clip")
    if any(bool(getattr(slot, "is_triggered", False)) for slot in (original, target)) or bool(getattr(original.clip, "is_triggered", False)):
        raise ValueError("resolve pending source or destination launches before copying")
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
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "trackId": track_id,
            "sourceClipId": params["sourceClipId"], "targetClipId": params["targetClipId"], "targetTrackId": target_track_id,
            "sourceTrackName": track.name, "targetTrackName": target_track.name,
            "identityToken": cached[1], "source": _content(song, track_id, params["sourceClipId"], version),
            "target": {"id": params["targetClipId"], "hasClip": False}}


def _comparable(content):
    result = dict(content)
    if "notes" in result:
        result["notes"] = sorted([{key: value for key, value in note.items() if key != "noteId"}
                                  for note in result["notes"]], key=lambda note: json.dumps(note, sort_keys=True))
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
    with _undo_step(song):
        try:
            original.duplicate_clip_to(target)
            if not _same(song, params, identity) or not target.has_clip or target.clip == original.clip:
                raise RuntimeError("clip copy ownership is unconfirmed; native topology changed or copy is absent")
            created = target.clip
            if "name" in params:
                created.name = name
            copied = _content(song, target_track_id, params["targetClipId"], version)
            if _comparable(copied) != _comparable({**before["source"], "name": name}):
                raise RuntimeError("clip copy readback mismatch")
            if _content(song, track_id, params["sourceClipId"], version) != before["source"]:
                raise RuntimeError("original clip changed while copying")
            if not _same(song, params, identity) or not target.has_clip or target.clip != created:
                raise RuntimeError("clip copy ownership changed during readback")
        except Exception as error:
            if created is None or not _same(song, params, identity) or not target.has_clip or target.clip != created:
                raise RuntimeError(f"clip copy failed: {error}; cleanup skipped because ownership is unconfirmed; inspect destination before retrying") from error
            try:
                target.delete_clip()
                if not _same(song, params, identity) or target.has_clip:
                    raise RuntimeError("new copy remains in destination")
            except Exception as cleanup_error:
                raise RuntimeError("clip copy failed: %s; cleanup failed: %s" % (error, cleanup_error)) from error
            raise
    return {**_clip_list(song, target_track_id, version + 1), "sourceTrackId": track_id,
            "sourceClipId": params["sourceClipId"], "copiedClipId": params["targetClipId"],
            "copyVerified": True, "limitation": "Verified exposed clip state; destination processing is unchanged. Hidden state, envelope contents/retargeting and external source-file bytes are not compared. Audio copies share their source file."}
