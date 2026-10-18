"""Track, Return and Main fader edits resolved through Live's native dB display."""
import math
import re
import uuid

try:
    from .bridge import _device_owner, _set_fingerprint, _parameter_automation_state, _undo_step
except ImportError:
    from bridge import _device_owner, _set_fingerprint, _parameter_automation_state, _undo_step

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


def _resolve(song, track_id):
    if not isinstance(track_id, str) or not re.fullmatch(r'(?:master|(?:track|return)-(?:0|[1-9][0-9]*))', track_id):
        raise ValueError("canonical track, Return or master ID required")
    _, owner = _device_owner(song, track_id)
    mixer = owner.mixer_device
    return owner, mixer, mixer.volume


def _writable(song, track_id, track, parameter):
    if track_id.startswith('track-') and getattr(track, 'is_frozen', None) is not False:
        raise ValueError("track fader is frozen or freeze state is unavailable")
    if getattr(parameter, "is_enabled", None) is not True or bool(getattr(parameter, "is_quantized", False)):
        raise ValueError("track fader is disabled or not continuous")
    if _parameter_automation_state(parameter) != {"value": 0, "name": "none"}:
        raise ValueError("track fader automation must be known and inactive")
    recording = {"arrangement": bool(song.record_mode), "session": bool(song.session_record),
                 "countingIn": bool(getattr(song, 'is_counting_in', False))}
    if any(recording.values()):
        raise ValueError("resolve recording and count-in before changing a fader")
    return recording


def source(song, params, version):
    global _song
    requested = params.get("volumeDb")
    if type(requested) not in (int, float) or not math.isfinite(requested):
        raise ValueError("volumeDb must be finite")
    track_id = params.get('trackId')
    track, mixer, parameter = _resolve(song, track_id)
    recording = _writable(song, track_id, track, parameter)
    if _song != song:
        _song = song
        _identities.clear()
    identity = (track, mixer, parameter)
    cached = _identities.get(track_id)
    if cached is None or cached[0] != identity:
        if track_id not in _identities and len(_identities) >= 321:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[track_id] = cached
    is_group = bool(getattr(track, 'is_foldable', False))
    kind = 'master' if track_id == 'master' else 'return' if track_id.startswith('return-') else 'group' if is_group else 'track'
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": track_id, "name": getattr(track, 'name', 'Main' if kind == 'master' else None),
            "ownerType": kind, "isGroup": is_group,
            "recording": recording, "volume": volume_record(parameter), "requestedVolumeDb": requested,
            "target": _target(parameter, requested)}


def apply(song, params, version):
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("track fader context changed; review a fresh plan")
    binding = _resolve(song, params['trackId'])
    track, mixer, parameter = binding
    def check_binding():
        if _resolve(song, params['trackId']) != binding:
            raise ValueError('fader owner, mixer or parameter changed')
        _writable(song, params['trackId'], track, parameter)
    original, target = parameter.value, before["target"]["value"]
    changed = original != target
    if changed:
        with _undo_step(song):
            if source(song, params, version) != before:
                raise ValueError('fader context changed at undo entry')
            check_binding()
            try:
                parameter.value = target
                check_binding()
                observed = volume_record(parameter)
                if abs(observed["value"] - target) > 1e-6 or observed["decibels"] is None or \
                        abs(observed["decibels"] - params["volumeDb"]) > _tolerance_db + 1e-9 or \
                        observed["automationState"] != before["volume"]["automationState"]:
                    raise RuntimeError("track volume native readback mismatch")
            except Exception as error:
                try:
                    check_binding()
                    parameter.value = original
                    if parameter.value != original:
                        raise RuntimeError("original fader value was not restored")
                    check_binding()
                except Exception as rollback_error:
                    raise RuntimeError(f"track volume failed: {error}; rollback failed: {rollback_error}") from error
                raise
    check_binding()
    observed = volume_record(parameter)
    check_binding()
    if abs(observed['value'] - target) > 1e-6 or observed['decibels'] is None or \
            abs(observed['decibels'] - params['volumeDb']) > _tolerance_db + 1e-9:
        raise RuntimeError('fader changed after undo completion; inspect the retained partial result')
    return {"stateVersion": version + 1, "trackId": params["trackId"], "changed": changed,
            "volume": observed, "verified": True}
