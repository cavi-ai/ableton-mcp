"""Track fader edits resolved through Live's native dB display."""
import math
import re
import uuid

try:
    from .bridge import _track, _set_fingerprint, _parameter_automation_state, _undo_step
except ImportError:
    from bridge import _track, _set_fingerprint, _parameter_automation_state, _undo_step

_song = None
_identities = {}
_tolerance_db = 0.05


def _decibels(display):
    if not isinstance(display, str):
        raise ValueError("native gain dB display is unavailable")
    text = display.strip().replace("−", "-")
    if text.lower() in ("-inf db", "-infinity db", "-∞ db"):
        return -math.inf
    match = re.fullmatch(r"([+-]?(?:[0-9]+(?:[.,][0-9]*)?|[.,][0-9]+))\s*dB", text, re.IGNORECASE)
    if not match:
        raise ValueError("native gain dB display is unavailable")
    value = float(match[1].replace(",", "."))
    if not math.isfinite(value):
        raise ValueError("native gain dB display is unavailable")
    return value


def volume_record(parameter):
    try:
        display = parameter.str_for_value(parameter.value)
    except Exception:
        display = None
    try:
        db = _decibels(display)
    except ValueError:
        db = None
    return {"value": parameter.value, "min": parameter.min, "max": parameter.max,
            "displayValue": display, "decibels": db if db is not None and math.isfinite(db) else None,
            "enabled": getattr(parameter, "is_enabled", None),
            "automationState": _parameter_automation_state(parameter)}


def _target(parameter, requested):
    low, high = float(parameter.min), float(parameter.max)
    if not math.isfinite(low) or not math.isfinite(high) or low >= high:
        raise ValueError("native gain bounds are unavailable")
    def candidate(value):
        display = parameter.str_for_value(value)
        return {"value": value, "displayValue": display, "decibels": _decibels(display)}
    bottom, top, current = candidate(low), candidate(high), candidate(parameter.value)
    if bottom["decibels"] > top["decibels"] or not math.isfinite(top["decibels"]):
        raise ValueError("native gain dB scale is unavailable")
    if requested < bottom["decibels"] or requested > top["decibels"]:
        raise ValueError("requested dB level is outside the native gain range")
    best = min([bottom, top, current], key=lambda item: abs(item["decibels"] - requested))
    # Query the native formatter without moving the fader. No normalized-to-dB
    # formula is assumed, and unrepresentable targets are refused.
    for _ in range(32):
        middle = (low + high) / 2
        item = candidate(middle)
        if abs(item["decibels"] - requested) < abs(best["decibels"] - requested):
            best = item
        if item["decibels"] < requested:
            low = middle
        else:
            high = middle
    if not math.isfinite(best["decibels"]) or abs(best["decibels"] - requested) > _tolerance_db + 1e-9:
        raise ValueError("requested level is not representable within 0.05 dB on the native gain control")
    return best


def source(song, params, version):
    global _song
    requested = params.get("volumeDb")
    if type(requested) not in (int, float) or not math.isfinite(requested):
        raise ValueError("volumeDb must be finite")
    index, track = _track(song, params.get("trackId"))
    parameter = track.mixer_device.volume
    if bool(getattr(track, "is_frozen", False)):
        raise ValueError("track fader is frozen")
    if getattr(parameter, "is_enabled", None) is not True or bool(getattr(parameter, "is_quantized", False)):
        raise ValueError("track fader is disabled or not continuous")
    if _parameter_automation_state(parameter) != {"value": 0, "name": "none"}:
        raise ValueError("track fader automation must be known and inactive")
    recording = {"arrangement": bool(song.record_mode), "session": bool(song.session_record)}
    if any(recording.values()):
        raise ValueError("resolve recording before changing a track fader")
    if _song != song:
        _song = song
        _identities.clear()
    identity = (track, parameter)
    cached = _identities.get(index)
    if cached is None or cached[0] != identity:
        if index not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[index] = cached
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": params["trackId"], "name": track.name, "isGroup": bool(getattr(track, "is_foldable", False)),
            "recording": recording, "volume": volume_record(parameter), "requestedVolumeDb": requested,
            "target": _target(parameter, requested)}


def apply(song, params, version):
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("track fader context changed; review a fresh plan")
    _, track = _track(song, params["trackId"])
    parameter = track.mixer_device.volume
    original, target = parameter.value, before["target"]["value"]
    changed = original != target
    if changed:
        with _undo_step(song):
            try:
                parameter.value = target
                observed = volume_record(parameter)
                if abs(observed["value"] - target) > 1e-6 or observed["decibels"] is None or \
                        abs(observed["decibels"] - params["volumeDb"]) > _tolerance_db + 1e-9 or \
                        observed["automationState"] != before["volume"]["automationState"]:
                    raise RuntimeError("track volume native readback mismatch")
            except Exception as error:
                try:
                    parameter.value = original
                    if parameter.value != original:
                        raise RuntimeError("original fader value was not restored")
                except Exception as rollback_error:
                    raise RuntimeError(f"track volume failed: {error}; rollback failed: {rollback_error}") from error
                raise
    return {"stateVersion": version + 1, "trackId": params["trackId"], "changed": changed,
            "volume": volume_record(parameter), "verified": True}
