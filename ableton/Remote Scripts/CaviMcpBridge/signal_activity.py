"""One read of native peak-hold meters; no listeners, waits or meter conversion."""
import math


def _optional(owner, name, valid):
    try:
        value = getattr(owner, name)
    except Exception:
        return None
    return value if valid(value) else None


def _boolean(owner, name):
    value = _optional(owner, name, lambda value: type(value) in (bool, int) and value in (0, 1))
    return None if value is None else bool(value)


def _meter(track, name):
    try:
        value = getattr(track, name)
    except Exception:
        return {"status": "unavailable", "value": None}
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        return {"status": "invalid", "value": None}
    return {"status": "available", "value": value}


def snapshot(song, params, state_version):
    try:
        from .bridge import _device_owner
    except ImportError:
        from bridge import _device_owner
    track_id, track = _device_owner(song, params["trackId"])
    integer = lambda value: type(value) is int
    return {
        "stateVersion": state_version, "trackId": track_id, "name": track.name,
        "snapshotOnly": True, "audibleOutputVerified": False,
        "hasAudioOutput": _boolean(track, "has_audio_output"),
        "hasMidiOutput": _boolean(track, "has_midi_output"),
        "meterSemantics": {"unit": "native_0_to_1", "kind": "peak_hold", "holdSeconds": 1},
        "meters": {"input": _meter(track, "input_meter_level"), "output": _meter(track, "output_meter_level")},
        "transport": {"isPlaying": bool(song.is_playing), "currentSongTimeBeats": float(song.current_song_time)},
        "controls": {
            "mute": _boolean(track, "mute"), "solo": _boolean(track, "solo"),
            "mutedViaSolo": _boolean(track, "muted_via_solo"), "armed": _boolean(track, "arm"),
            "monitoringState": _optional(track, "current_monitoring_state", lambda value: integer(value) and value in (0, 1, 2)),
            "playingSlotIndex": _optional(track, "playing_slot_index", integer),
            "firedSlotIndex": _optional(track, "fired_slot_index", integer),
        },
    }
