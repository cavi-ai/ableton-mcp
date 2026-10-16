"""Guarded native Session copies for audio and MIDI development."""
import json
import uuid

try:
    from .bridge import _clip_slot, _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint, _undo_step, _clip_list
except ImportError:
    from bridge import _clip_slot, _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint, _undo_step, _clip_list

_song = None
_identities = {}


def _content(song, track_id, clip_id, version):
    _, _, slot = _clip_slot(song, track_id, clip_id)
    clip = slot.clip
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
    track_id = params["trackId"]
    track, _, original = _clip_slot(song, track_id, params["sourceClipId"])
    _, _, target = _clip_slot(song, track_id, params["targetClipId"])
    if original == target:
        raise ValueError("source and target clips must differ")
    if not original.has_clip:
        raise ValueError("source clip is empty")
    if target.has_clip:
        raise ValueError("target clip must be empty")
    if bool(getattr(track, "is_frozen", False)):
        raise ValueError("clip duplication is unavailable on a frozen track")
    if song.record_mode or song.session_record or bool(getattr(original.clip, "is_recording", False)):
        raise ValueError("resolve recording before copying a clip")
    if any(bool(getattr(slot, "is_triggered", False)) for slot in (original, target)) or bool(getattr(original.clip, "is_triggered", False)):
        raise ValueError("resolve pending source or destination launches before copying")
    if _song != song:
        _song = song
        _identities.clear()
    key = (track_id, params["sourceClipId"], params["targetClipId"])
    identity = (tuple(song.tracks), track, original, original.clip, target)
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "trackId": track_id,
            "sourceClipId": params["sourceClipId"], "targetClipId": params["targetClipId"],
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
    track_id = params["trackId"]
    _, _, original = _clip_slot(song, track_id, params["sourceClipId"])
    _, _, target = _clip_slot(song, track_id, params["targetClipId"])
    with _undo_step(song):
        try:
            original.duplicate_clip_to(target)
            if not target.has_clip or target.clip == original.clip:
                raise RuntimeError("clip copy readback mismatch")
            if "name" in params:
                target.clip.name = name
            copied = _content(song, track_id, params["targetClipId"], version)
            if _comparable(copied) != _comparable({**before["source"], "name": name}):
                raise RuntimeError("clip copy readback mismatch")
            if _content(song, track_id, params["sourceClipId"], version) != before["source"]:
                raise RuntimeError("original clip changed while copying")
        except Exception as error:
            try:
                if target.has_clip:
                    target.delete_clip()
                if target.has_clip:
                    raise RuntimeError("new copy remains in destination")
            except Exception as cleanup_error:
                raise RuntimeError("clip copy failed: %s; cleanup failed: %s" % (error, cleanup_error)) from error
            raise
    return {**_clip_list(song, track_id, version + 1), "copiedClipId": params["targetClipId"],
            "copyVerified": True, "limitation": "Verified exposed clip state; native duplication carries envelopes. Hidden state, envelope contents and external source-file bytes are not compared."}
