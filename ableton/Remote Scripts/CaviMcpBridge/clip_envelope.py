"""Guarded creation and explicit whole-lane Session envelope replacement."""
import hashlib
import json
import math
import uuid

try:
    from .bridge import _clip_slot, _parameter_record, _parameter_automation_state, _set_fingerprint, _undo_step
    from .clip_duplication import _content
    from .parameter_display import _resolve, _quantity, _target
    from .track_send import _resolve as _resolve_send
except ImportError:
    from bridge import _clip_slot, _parameter_record, _parameter_automation_state, _set_fingerprint, _undo_step
    from clip_duplication import _content
    from parameter_display import _resolve, _quantity, _target
    from track_send import _resolve as _resolve_send

_song = None
_identities = {}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def _selector(params, mixer=False):
    if not mixer:
        return {key: params[key] for key in ("deviceId", "parameterId")}
    control = params.get("mixerControl")
    if control in ("volume", "pan"):
        if "sendId" in params or "returnTrackId" in params:
            raise ValueError(f"{control} envelopes do not accept send or Return IDs")
        return {"mixerControl": control}
    if control == "send":
        return {"mixerControl": control, "sendId": params.get("sendId"), "returnTrackId": params.get("returnTrackId")}
    raise ValueError("mixerControl must be volume, pan or send")


def _objects(song, params, mixer=False):
    track, _, slot = _clip_slot(song, params.get("trackId"), params.get("clipId"))
    if not slot.has_clip:
        raise ValueError("Session clip is empty")
    _selector(params, mixer)
    if mixer:
        device = track.mixer_device
        parameters = (device.volume, device.panning, *device.sends)
        related = tuple(song.return_tracks)
        if len(parameters) > 258 or len(related) > 256:
            raise ValueError("mixer envelope context exceeds 256 sends or Returns")
        index = 0
        if params["mixerControl"] == "pan":
            if getattr(device, "panning_mode", None) != 0:
                raise ValueError("pan envelopes require known Stereo panning mode; Split Stereo is unsupported")
            index = 1
        if params["mixerControl"] == "send":
            _, send_index, _, _, _ = _resolve_send(song, params)
            index = send_index + 2
        parameter = parameters[index]
    else:
        _, device, index, parameter = _resolve(song, params)
        parameters, related = tuple(device.parameters), ()
    clip = slot.clip
    return track, slot, clip, device, index, parameter, parameters, related


def _identity(objects):
    track, slot, clip, device, _, _, parameters, related = objects
    return track, slot, clip, device, parameters, related


def _same(song, params, identity, mixer=False):
    try:
        return _identity(_objects(song, params, mixer)) == identity
    except (ValueError, RuntimeError):
        return False


def _points(parameter, requested, end, limit=128):
    if not isinstance(requested, list) or not 1 <= len(requested) <= limit:
        raise ValueError(f"points must contain 1 to {limit} ordered steps")
    result, previous_end = [], 0
    for point in requested:
        if not isinstance(point, dict) or set(point) not in ({"time", "duration", "value"}, {"time", "duration", "targetDisplay"}):
            raise ValueError("each step requires time, duration and exactly one value or targetDisplay")
        time, duration = point["time"], point["duration"]
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in (time, duration)) or \
                time < 0 or time < previous_end and not math.isclose(time, previous_end, rel_tol=0, abs_tol=1e-9) or \
                duration <= 0 or time + duration > end and not math.isclose(time + duration, end, rel_tol=0, abs_tol=1e-9):
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


def _replacement_points(parameter, requested, end):
    if not isinstance(requested, list) or not 1 <= len(requested) <= 512:
        raise ValueError("points must contain 1 to 512 ordered steps")
    normalized = []
    for point in requested:
        if not isinstance(point, dict) or set(point) != {"time", "duration", "value"}:
            raise ValueError("replacement steps require time, duration and a native value")
        value = point["value"]
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("replacement step value must be finite")
        normalized.append({**point, "value": max(parameter.min, min(parameter.max, value))})
    points = _points(parameter, normalized, end, limit=512)
    return [{**point, "requestedValue": raw["value"]} for point, raw in zip(points, requested)]


def _envelope_samples(envelope, parameter, points, end):
    if envelope is None:
        return []
    times = {end * index / 16 for index in range(17)}
    for point in points:
        times.update(point["time"] + point["duration"] * fraction for fraction in (0, .000001, .5, .999999))
    samples = []
    for time in sorted(times):
        value = float(envelope.value_at_time(time))
        if not math.isfinite(value):
            raise ValueError("existing envelope samples are unavailable")
        samples.append({"time": time, "value": value, "displayValue": parameter.str_for_value(value)})
    return samples


def source(song, params, version, replacement=False, mixer=False):
    global _song
    objects = _objects(song, params, mixer)
    track, slot, clip, device, index, parameter, parameters, _ = objects
    if song.is_playing or song.record_mode or song.session_record or bool(getattr(clip, "is_recording", False)) or \
            bool(getattr(clip, "is_playing", False)) or bool(getattr(clip, "is_triggered", False)) or bool(getattr(slot, "is_triggered", False)):
        raise ValueError("resolve playback, recording and pending clip launches before editing an envelope")
    if bool(getattr(track, "is_frozen", False)):
        raise ValueError("clip owner is frozen")
    if bool(getattr(clip, "is_audio_clip", False)) and not bool(clip.warping):
        raise ValueError("unwarped audio envelope timing is unsupported; beat-based clips required")
    if getattr(parameter, "is_enabled", None) is not True or _parameter_automation_state(parameter) != {"value": 0, "name": "none"}:
        raise ValueError("parameter must be enabled with known inactive automation")
    envelope = clip.automation_envelope(parameter)
    if replacement:
        if "replaceExisting" in params and type(params["replaceExisting"]) is not bool:
            raise ValueError("replaceExisting must be a boolean")
        if envelope is not None and params.get("replaceExisting") is not True:
            raise ValueError("replaceExisting: true is required to discard the entire existing envelope")
    elif envelope is not None:
        raise ValueError("existing envelope is preserved; choose another clip or parameter")
    content = _content(song, params["trackId"], params["clipId"], version)
    end = max(float(clip.loop_end), float(getattr(clip, "end_marker", clip.length)))
    if not math.isfinite(end) or end <= 0:
        raise ValueError("clip beat range is unavailable")
    if mixer and params["mixerControl"] == "pan" and isinstance(params.get("points"), list) and any(
            isinstance(point, dict) and "targetDisplay" in point for point in params["points"]):
        raise ValueError("pan steps require exact raw native values, not display targets")
    points = (_replacement_points if replacement else _points)(parameter, params.get("points"), end)
    if _song != song:
        _song = song
        _identities.clear()
    selector = _selector(params, mixer)
    key = (params["trackId"], params["clipId"], tuple(sorted(selector.items())))
    identity = (*_identity(objects), envelope)
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": params["trackId"], "clipId": params["clipId"], **selector,
            "clipName": clip.name, "clipTiming": content["timing"],
            "contentDigest": _digest(content), "parametersDigest": _digest([_parameter_record(p, i) for i, p in enumerate(parameters)]),
            "parameter": _parameter_record(parameter, index), "envelopeExists": envelope is not None,
            "endBeats": end, "points": points,
            **({"panningMode": int(device.panning_mode)} if mixer and params["mixerControl"] == "pan" else {}),
            **({"returnName": song.return_tracks[index - 2].name} if mixer and params["mixerControl"] == "send" else {}),
            **({"replaceExisting": params.get("replaceExisting", False), "fullCurveCaptured": False,
                "envelopeSamples": _envelope_samples(envelope, parameter, points, end)} if replacement else {})}


def replacement_source(song, params, version):
    return source(song, params, version, replacement=True)


def _insert_and_read(song, params, version, objects, before, created, identity, mixer=False):
    _, _, clip, _, index, parameter, _, _ = objects
    if created is None or not _same(song, params, identity, mixer) or clip.automation_envelope(parameter) != created:
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
    if not _same(song, params, identity, mixer) or clip.automation_envelope(parameter) != created:
        raise RuntimeError("clip envelope topology changed during editing")
    if _digest(_content(song, params["trackId"], params["clipId"], version)) != before["contentDigest"]:
        raise RuntimeError("clip material changed during envelope editing")
    return samples, boundaries, parameter_after


def create(song, params, version, mixer=False):
    before = source(song, params, version, mixer=mixer)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("clip envelope context changed; review a fresh plan")
    return _create_prepared(song, params, version, before, mixer)


def _create_prepared(song, params, version, before, mixer=False):
    objects = _objects(song, params, mixer)
    _, _, clip, device, index, parameter, _, _ = objects
    identity, original, created = _identity(objects), parameter.value, None
    with _undo_step(song):
        try:
            created = clip.create_automation_envelope(parameter)
            samples, boundaries, parameter_after = _insert_and_read(song, params, version, objects, before, created, identity, mixer)
        except Exception as error:
            if created is None or not _same(song, params, identity, mixer) or clip.automation_envelope(parameter) != created:
                raise RuntimeError(f"envelope creation failed: {error}; cleanup skipped because ownership is unconfirmed; inspect current clip") from error
            try:
                clip.clear_envelope(parameter)
                if not _same(song, params, identity, mixer):
                    raise RuntimeError("native topology changed during cleanup")
                if clip.automation_envelope(parameter) is not None:
                    raise RuntimeError("new envelope was not removed")
                if parameter.value != original:
                    if _parameter_automation_state(parameter) != {"value": 0, "name": "none"} or not parameter.is_enabled:
                        raise RuntimeError("original parameter ownership is unavailable")
                    parameter.value = original
                    if not _same(song, params, identity, mixer) or parameter.value != original:
                        raise RuntimeError("original parameter value was not restored")
            except Exception as cleanup_error:
                raise RuntimeError(f"envelope creation failed: {error}; cleanup failed: {cleanup_error}; inspect current clip") from error
            raise
    return {"stateVersion": version + 1, "trackId": params["trackId"], "clipId": params["clipId"],
            **_selector(params, mixer), "created": True,
            "verified": True, "verificationScope": "sampled_steps", "samples": samples, "boundarySamples": boundaries,
            "parameter": parameter_after}


def replace(song, params, version):
    before = replacement_source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("clip envelope replacement context changed; review a fresh plan")
    if not before["envelopeExists"]:
        return {**_create_prepared(song, params, version, before), "replaced": True, "replacedExisting": False}
    objects = _objects(song, params)
    _, _, clip, _, _, parameter, _, _ = objects
    identity = _identity(objects)
    with _undo_step(song):
        try:
            clip.clear_envelope(parameter)
            if not _same(song, params, identity) or clip.automation_envelope(parameter) is not None:
                raise RuntimeError("native envelope target changed during clear")
            created = clip.create_automation_envelope(parameter)
            samples, boundaries, parameter_after = _insert_and_read(song, params, version, objects, before, created, identity)
        except Exception as error:
            raise RuntimeError(f"envelope replacement failed after clear was requested: {error}; previous curve was not backed up; partial state preserved; inspect current lane before retrying") from error
    return {"stateVersion": version + 1, "trackId": params["trackId"], "clipId": params["clipId"],
            "deviceId": params["deviceId"], "parameterId": params["parameterId"], "replaced": True,
            "replacedExisting": True, "verified": True, "verificationScope": "sampled_steps",
            "fullCurveCaptured": False, "samples": samples, "boundarySamples": boundaries, "parameter": parameter_after}


def read_mixer(song, params, version):
    _, _, clip, device, index, parameter, _, _ = _objects(song, params, mixer=True)
    if bool(getattr(clip, "is_audio_clip", False)) and not bool(clip.warping):
        raise ValueError("unwarped audio envelope timing is unsupported; beat-based clips required")
    times = params.get("sampleTimes", [])
    if not isinstance(times, list) or len(times) > 512 or any(type(t) not in (int, float) or not math.isfinite(t) or t < 0 for t in times):
        raise ValueError("sampleTimes requires at most 512 finite nonnegative beat positions")
    envelope = clip.automation_envelope(parameter)
    samples = []
    if envelope is not None:
        for time in times:
            value = float(envelope.value_at_time(time))
            if not math.isfinite(value):
                raise ValueError("mixer envelope sample is unavailable")
            samples.append({"time": time, "value": value, "displayValue": parameter.str_for_value(value)})
    return {"stateVersion": version, "trackId": params["trackId"], "clipId": params["clipId"],
            **_selector(params, mixer=True), "clipLengthBeats": float(clip.length), "parameter": _parameter_record(parameter, index),
            **({"panningMode": int(device.panning_mode)} if params["mixerControl"] == "pan" else {}),
            "exists": envelope is not None, "samples": samples}
