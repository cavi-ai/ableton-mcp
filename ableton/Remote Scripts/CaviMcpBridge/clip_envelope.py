"""Create an absent Session automation lane without replacing a curve."""
import hashlib
import json
import math
import uuid

try:
    from .bridge import _clip_slot, _parameter_record, _parameter_automation_state, _set_fingerprint, _undo_step
    from .clip_duplication import _content
    from .parameter_display import _resolve, _parameters, _quantity, _target
except ImportError:
    from bridge import _clip_slot, _parameter_record, _parameter_automation_state, _set_fingerprint, _undo_step
    from clip_duplication import _content
    from parameter_display import _resolve, _parameters, _quantity, _target

_song = None
_identities = {}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def _objects(song, params):
    track, _, slot = _clip_slot(song, params.get("trackId"), params.get("clipId"))
    if not slot.has_clip:
        raise ValueError("Session clip is empty")
    _, device, index, parameter = _resolve(song, params)
    clip = slot.clip
    return track, slot, clip, device, index, parameter


def _identity(objects):
    track, slot, clip, device, _, _ = objects
    return track, slot, clip, device, tuple(device.parameters)


def _same(song, params, identity):
    try:
        return _identity(_objects(song, params)) == identity
    except (ValueError, RuntimeError):
        return False


def _points(parameter, requested, end):
    if not isinstance(requested, list) or not 1 <= len(requested) <= 128:
        raise ValueError("points must contain 1 to 128 ordered steps")
    result, previous_end = [], 0
    for point in requested:
        if not isinstance(point, dict) or set(point) not in ({"time", "duration", "value"}, {"time", "duration", "targetDisplay"}):
            raise ValueError("each step requires time, duration and exactly one value or targetDisplay")
        time, duration = point["time"], point["duration"]
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in (time, duration)) or \
                time < previous_end or duration <= 0 or time + duration > end:
            raise ValueError("steps must be finite, ordered, nonoverlapping and within the clip beat range")
        if "targetDisplay" in point:
            if parameter.is_quantized:
                raise ValueError("unit targets require a continuous parameter")
            target = _target(parameter, _quantity(point["targetDisplay"]))
            value, display = target["value"], target["displayValue"]
        else:
            value = point["value"]
            if type(value) not in (int, float) or not math.isfinite(value) or not parameter.min <= value <= parameter.max or \
                    parameter.is_quantized and not float(value).is_integer():
                raise ValueError("raw step value must be exact and within native bounds; no clamping")
            display = parameter.str_for_value(value)
        result.append({"time": time, "duration": duration, "value": value, "displayValue": display})
        previous_end = time + duration
    return result


def source(song, params, version):
    global _song
    objects = _objects(song, params)
    track, slot, clip, device, index, parameter = objects
    if song.is_playing or song.record_mode or song.session_record or bool(getattr(clip, "is_recording", False)) or \
            bool(getattr(clip, "is_playing", False)) or bool(getattr(clip, "is_triggered", False)) or bool(getattr(slot, "is_triggered", False)):
        raise ValueError("resolve playback, recording and pending clip launches before creating an envelope")
    if bool(getattr(track, "is_frozen", False)):
        raise ValueError("clip owner is frozen")
    if bool(getattr(clip, "is_audio_clip", False)) and not bool(clip.warping):
        raise ValueError("unwarped audio envelope timing is unsupported; beat-based clips required")
    if getattr(parameter, "is_enabled", None) is not True or _parameter_automation_state(parameter) != {"value": 0, "name": "none"}:
        raise ValueError("parameter must be enabled with known inactive automation")
    if clip.automation_envelope(parameter) is not None:
        raise ValueError("existing envelope is preserved; choose another clip or parameter")
    content = _content(song, params["trackId"], params["clipId"], version)
    end = max(float(clip.loop_end), float(getattr(clip, "end_marker", clip.length)))
    if not math.isfinite(end) or end <= 0:
        raise ValueError("clip beat range is unavailable")
    points = _points(parameter, params.get("points"), end)
    if _song != song:
        _song = song
        _identities.clear()
    key, identity = (params["trackId"], params["clipId"], params["deviceId"]), _identity(objects)
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": params["trackId"], "clipId": params["clipId"], "deviceId": params["deviceId"],
            "parameterId": params["parameterId"], "clipName": clip.name, "clipTiming": content["timing"],
            "contentDigest": _digest(content), "parametersDigest": _digest(_parameters(device)),
            "parameter": _parameter_record(parameter, index), "envelopeExists": False,
            "endBeats": end, "points": points}


def create(song, params, version):
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("clip envelope context changed; review a fresh plan")
    objects = _objects(song, params)
    _, _, clip, device, index, parameter = objects
    identity, original, created = _identity(objects), parameter.value, None
    with _undo_step(song):
        try:
            created = clip.create_automation_envelope(parameter)
            if created is None or not _same(song, params, identity) or clip.automation_envelope(parameter) != created:
                raise RuntimeError("new envelope ownership is unconfirmed")
            for point in before["points"]:
                created.insert_step(float(point["time"]), float(point["duration"]), float(point["value"]))
            samples, boundaries = [], []
            for point in before["points"]:
                # Live returns the preceding value exactly at a step's start.
                # Observe boundaries separately; verify the step to their right.
                boundary = float(created.value_at_time(point["time"]))
                if not math.isfinite(boundary):
                    raise RuntimeError("clip envelope boundary readback is unavailable")
                boundaries.append({"time": point["time"], "value": boundary,
                                   "displayValue": parameter.str_for_value(boundary)})
                for fraction in (.000001, .5, .999999):
                    time = point["time"] + point["duration"] * fraction
                    value = float(created.value_at_time(time))
                    display = parameter.str_for_value(value)
                    if not math.isfinite(value) or abs(value - point["value"]) > 1e-6 or display != point["displayValue"]:
                        raise RuntimeError(f"clip envelope step readback mismatch at {time}: expected {point['value']} ({point['displayValue']}), observed {value} ({display})")
                    samples.append({"time": time, "value": value, "displayValue": display})
            parameter_after = _parameter_record(parameter, index)
            if not _same(song, params, identity) or clip.automation_envelope(parameter) != created:
                raise RuntimeError("clip envelope topology changed during creation")
            if _digest(_content(song, params["trackId"], params["clipId"], version)) != before["contentDigest"]:
                raise RuntimeError("clip material changed during envelope creation")
        except Exception as error:
            if created is None or not _same(song, params, identity) or clip.automation_envelope(parameter) != created:
                raise RuntimeError(f"envelope creation failed: {error}; cleanup skipped because ownership is unconfirmed; inspect current clip") from error
            try:
                clip.clear_envelope(parameter)
                if not _same(song, params, identity):
                    raise RuntimeError("native topology changed during cleanup")
                if clip.automation_envelope(parameter) is not None:
                    raise RuntimeError("new envelope was not removed")
                if parameter.value != original:
                    if _parameter_automation_state(parameter) != {"value": 0, "name": "none"} or not parameter.is_enabled:
                        raise RuntimeError("original parameter ownership is unavailable")
                    parameter.value = original
                    if not _same(song, params, identity) or parameter.value != original:
                        raise RuntimeError("original parameter value was not restored")
            except Exception as cleanup_error:
                raise RuntimeError(f"envelope creation failed: {error}; cleanup failed: {cleanup_error}; inspect current clip") from error
            raise
    return {"stateVersion": version + 1, "trackId": params["trackId"], "clipId": params["clipId"],
            "deviceId": params["deviceId"], "parameterId": params["parameterId"], "created": True,
            "verified": True, "verificationScope": "sampled_steps", "samples": samples, "boundarySamples": boundaries,
            "parameter": parameter_after}
