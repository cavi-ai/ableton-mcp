"""Native readiness and identity guards for Session takes."""
import math
import uuid

try:
    from .bridge import (_clip_slot, _track_routing, _track_midi_routing, _transport_context,
                         _transport_recording_context, _set_fingerprint, CLIP_QUANTIZATION_NAMES)
except ImportError:
    from bridge import (_clip_slot, _track_routing, _track_midi_routing, _transport_context,
                        _transport_recording_context, _set_fingerprint, CLIP_QUANTIZATION_NAMES)

_song = None
_identities = {}


def source(song, params, version):
    global _song
    length = params.get("recordLengthBeats")
    if "recordLengthBeats" in params and (type(length) not in (int, float) or not math.isfinite(length) or length <= 0):
        raise ValueError("recordLengthBeats must be a positive finite number")
    track, index, slot = _clip_slot(song, params.get("trackId"), params.get("clipId"))
    if slot.has_clip:
        raise ValueError("fixed-length recording requires an empty clip slot")
    if not getattr(track, "can_be_armed", True) or not track.arm:
        raise ValueError("fixed-length recording requires an armed track")
    if bool(getattr(track, "is_frozen", False)):
        raise ValueError("fixed-length recording is unavailable on a frozen track")
    if song.record_mode or song.session_record:
        raise ValueError("resolve existing recording before starting a Session take")
    if len(song.tracks) > 256:
        raise ValueError("Session recording readiness supports at most 256 tracks")
    tracks, slot_count = [], 0
    for position, candidate in enumerate(song.tracks):
        armed = bool(candidate.arm) if getattr(candidate, "can_be_armed", True) else False
        if candidate != track and armed:
            raise ValueError("resolve other armed tracks before starting a Session take")
        slots = list(getattr(candidate, "clip_slots", ()))
        slot_count += len(slots)
        if slot_count > 16384:
            raise ValueError("Session recording readiness supports at most 16384 slots")
        fired = int(candidate.fired_slot_index)
        if fired != -1 or any(bool(getattr(item, "is_triggered", False)) or
                              item.has_clip and bool(getattr(item.clip, "is_triggered", False)) for item in slots):
            raise ValueError("resolve pending launches before starting a Session take")
        if any(item.has_clip and bool(getattr(item.clip, "is_recording", False)) for item in slots):
            raise ValueError("resolve existing clip recording before starting a Session take")
        playing = int(candidate.playing_slot_index)
        active = slots[playing].clip if 0 <= playing < len(slots) and slots[playing].has_clip else None
        tracks.append({"id": f"track-{position}", "name": candidate.name, "armed": armed,
                       "isGroup": bool(getattr(candidate, "is_foldable", False)),
                       "playingSlotIndex": playing, "playingClipName": active.name if active is not None else None,
                       "firedSlotIndex": fired})
    if _song != song:
        _song = song
        _identities.clear()
    key = (params["trackId"], index)
    identity = (tuple(song.tracks), track, slot)
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    recording = _transport_recording_context(song, version)
    # Neither the advancing clock nor newly incoming performance data changes
    # the recording destination. Do not bind Capture MIDI buffer readiness.
    recording.pop("currentSongTime")
    recording.pop("midiCapture")
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": params["trackId"], "clipId": params["clipId"], "recordLengthBeats": length,
            "slot": {"id": params["clipId"], "hasClip": False}, "armed": True, "canBeArmed": True, "isFrozen": False,
            "tracks": tracks, "routing": _track_routing(song, params["trackId"], version),
            "midiRouting": _track_midi_routing(song, params["trackId"], version),
            "recording": recording, "transport": _transport_context(song, version),
            "musical": {"tempo": float(song.tempo), "numerator": int(song.signature_numerator),
                        "denominator": int(song.signature_denominator),
                        "launchQuantization": int(song.clip_trigger_quantization),
                        "midiRecordingQuantization": int(song.midi_recording_quantization)},
            "launchQuantizationChoices": [{"value": value, "name": name} for value, name in enumerate(CLIP_QUANTIZATION_NAMES)]}
