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


def _track_record(track_id, track):
    integer = lambda value: type(value) is int
    return {
        "trackId": track_id, "name": track.name,
        "hasAudioOutput": _boolean(track, "has_audio_output"),
        "hasMidiOutput": _boolean(track, "has_midi_output"),
        "meters": {"input": _meter(track, "input_meter_level"), "output": _meter(track, "output_meter_level")},
        "controls": {
            "mute": _boolean(track, "mute"), "solo": _boolean(track, "solo"),
            "mutedViaSolo": _boolean(track, "muted_via_solo"), "armed": _boolean(track, "arm"),
            "monitoringState": _optional(track, "current_monitoring_state", lambda value: integer(value) and value in (0, 1, 2)),
            "playingSlotIndex": _optional(track, "playing_slot_index", integer),
            "firedSlotIndex": _optional(track, "fired_slot_index", integer),
        },
    }


def snapshot(song, params, state_version):
    try:
        from .bridge import _device_owner
    except ImportError:
        from bridge import _device_owner
    batch = "trackIds" in params
    if batch:
        ids = params["trackIds"]
        if ("trackId" in params or not isinstance(ids, list) or not 1 <= len(ids) <= 64
                or any(not isinstance(value, str) for value in ids) or len(set(ids)) != len(ids)):
            raise ValueError("provide 1-64 unique trackIds without trackId")
    else:
        ids = [params["trackId"]]
    # Resolve the entire scope before reading meters; never return a partial batch.
    owners = [_device_owner(song, track_id) for track_id in ids]
    common = {
        "stateVersion": state_version, "snapshotOnly": True, "audibleOutputVerified": False,
        "meterSemantics": {"unit": "native_0_to_1", "kind": "peak_hold", "holdSeconds": 1},
        "transport": {"isPlaying": bool(song.is_playing), "currentSongTimeBeats": float(song.current_song_time)},
    }
    records = [_track_record(track_id, track) for track_id, track in owners]
    return {**common, "tracks": records} if batch else {**common, **records[0]}
