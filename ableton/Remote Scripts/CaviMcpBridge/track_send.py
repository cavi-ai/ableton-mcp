"""One track-to-Return send gain resolved through Live's native display."""
import math
import re
import uuid

try:
    from .bridge import _track, _set_fingerprint, _parameter_automation_state, _undo_step
    from .track_volume import _decibels, _target, volume_record
except ImportError:
    from bridge import _track, _set_fingerprint, _parameter_automation_state, _undo_step
    from track_volume import _decibels, _target, volume_record

_song = None
_identities = {}


def send_record(parameter):
    record = volume_record(parameter)
    try:
        silent = _decibels(record["displayValue"]) == -math.inf
    except ValueError:
        silent = None
    return {**record, "silent": silent}


def _send_target(parameter, requested):
    if requested != "-inf":
        return {**_target(parameter, requested), "silent": False}
    minimum, maximum = float(parameter.min), float(parameter.max)
    if not math.isfinite(minimum) or not math.isfinite(maximum) or minimum >= maximum:
        raise ValueError("native send bounds are unavailable")
    display = parameter.str_for_value(minimum)
    if _decibels(display) != -math.inf:
        raise ValueError("native send has no verified silent minimum")
    return {"value": minimum, "displayValue": display, "decibels": None, "silent": True}


def _resolve(song, params):
    if not isinstance(params.get("trackId"), str) or not re.fullmatch(r"track-(0|[1-9][0-9]*)", params["trackId"]):
        raise ValueError("canonical trackId required")
    if not isinstance(params.get("sendId"), str) or not re.fullmatch(r"send-(0|[1-9][0-9]*)", params["sendId"]):
        raise ValueError("canonical sendId required")
    track_index, track = _track(song, params["trackId"])
    index = int(params["sendId"][5:])
    if params.get("returnTrackId") != f"return-{index}" or index >= len(song.return_tracks) or index >= len(track.mixer_device.sends):
        raise ValueError("sendId and returnTrackId must identify the same existing Return")
    return track_index, index, track, song.return_tracks[index], track.mixer_device.sends[index]


def source(song, params, version):
    global _song
    requested = params.get("sendDb")
    if requested != "-inf" and (type(requested) not in (int, float) or not math.isfinite(requested)):
        raise ValueError("sendDb must be finite or the explicit -inf target")
    track_index, index, track, destination, parameter = _resolve(song, params)
    if bool(getattr(track, "is_frozen", False)):
        raise ValueError("track send is frozen")
    if getattr(parameter, "is_enabled", None) is not True or bool(getattr(parameter, "is_quantized", False)):
        raise ValueError("track send is disabled or not continuous")
    if _parameter_automation_state(parameter) != {"value": 0, "name": "none"}:
        raise ValueError("track send automation must be known and inactive")
    recording = {"arrangement": bool(song.record_mode), "session": bool(song.session_record)}
    if any(recording.values()):
        raise ValueError("resolve recording before changing a track send")
    if _song != song:
        _song = song
        _identities.clear()
    key, identity = (track_index, index), (track, destination, parameter)
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": params["trackId"], "name": track.name, "isGroup": bool(getattr(track, "is_foldable", False)),
            "sendId": params["sendId"], "returnTrackId": params["returnTrackId"], "returnName": destination.name,
            "recording": recording, "send": send_record(parameter), "requestedSendDb": requested,
            "target": _send_target(parameter, requested)}


def apply(song, params, version):
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("track send context changed; review a fresh plan")
    _, _, _, _, parameter = _resolve(song, params)
    original, target = parameter.value, before["target"]["value"]
    changed = original != target
    if changed:
        with _undo_step(song):
            try:
                parameter.value = target
                observed = send_record(parameter)
                level_matches = observed["silent"] is True if before["target"]["silent"] else \
                    observed["decibels"] is not None and abs(observed["decibels"] - params["sendDb"]) <= .05 + 1e-9
                if abs(observed["value"] - target) > 1e-6 or not level_matches or \
                        observed["automationState"] != before["send"]["automationState"]:
                    raise RuntimeError("track send native readback mismatch")
            except Exception as error:
                try:
                    parameter.value = original
                    if parameter.value != original:
                        raise RuntimeError("original send value was not restored")
                except Exception as rollback_error:
                    raise RuntimeError(f"track send failed: {error}; rollback failed: {rollback_error}") from error
                raise
    return {"stateVersion": version + 1, "trackId": params["trackId"], "sendId": params["sendId"],
            "returnTrackId": params["returnTrackId"], "changed": changed,
            "send": send_record(parameter), "verified": True}
