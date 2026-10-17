"""Resolve one continuous device control through its native unit display."""
import hashlib
import json
import math
import re
import uuid

try:
    from .bridge import _device, _device_owner, _parameter_record, _parameter_automation_state, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _device, _device_owner, _parameter_record, _parameter_automation_state, _set_fingerprint, _undo_step

_song = None
_identities = {}
_units = {"Hz": ("Hz", 1), "kHz": ("Hz", 1000), "ms": ("ms", 1), "s": ("ms", 1000),
          "dB": ("dB", 1), "%": ("%", 1)}


def _quantity(display, boundary=False):
    if not isinstance(display, str) or len(display) > 96:
        raise ValueError("numeric native display with a supported unit required")
    text = display.strip().replace("−", "-")
    if boundary and text in ("-inf dB", "-infinity dB", "-∞ dB"):
        return {"value": -math.inf, "unit": "dB"}
    match = re.fullmatch(r"([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))\s*(Hz|kHz|ms|s|dB|%)", text)
    if not match:
        raise ValueError("numeric native display must use Hz, kHz, ms, s, dB or % with a decimal point")
    unit, multiplier = _units[match[2]]
    value = float(match[1]) * multiplier
    if not math.isfinite(value):
        raise ValueError("finite native display target required")
    return {"value": value, "unit": unit}


def _equal(left, right):
    return left["unit"] == right["unit"] and math.isclose(left["value"], right["value"], rel_tol=1e-9, abs_tol=1e-9)


def _target(parameter, requested, include_current=True):
    low, high = float(parameter.min), float(parameter.max)
    if not math.isfinite(low) or not math.isfinite(high) or low >= high:
        raise ValueError("native parameter bounds unavailable")

    def candidate(value):
        display = parameter.str_for_value(value)
        quantity = _quantity(display, boundary=True)
        if quantity["unit"] != requested["unit"]:
            raise ValueError("requested unit does not match the native parameter display")
        return {"value": value, "displayValue": display, "quantity": quantity}

    # Probe without writing. Refuse observed unit switches, flat scales and
    # reversals; no arbitrary plug-in transfer function is assumed.
    samples = [candidate(low + (high - low) * index / 16) for index in range(17)]
    values = [item["quantity"]["value"] for item in samples]
    ascending = values[-1] > values[0]
    if values[-1] == values[0] or any((b < a if ascending else b > a) for a, b in zip(values, values[1:])):
        raise ValueError("native display scale is not observably monotonic")
    if not min(values[0], values[-1]) <= requested["value"] <= max(values[0], values[-1]):
        raise ValueError("requested display is outside the native parameter range")
    candidates = [candidate(parameter.value), *samples] if include_current else samples
    for item in candidates:
        if _equal(item["quantity"], requested):
            return item
    for _ in range(48):
        middle = (low + high) / 2
        item = candidate(middle)
        if _equal(item["quantity"], requested):
            return item
        if (item["quantity"]["value"] < requested["value"]) == ascending:
            low = middle
        else:
            high = middle
    raise ValueError("requested display is not representable on the native parameter")


def _resolve(song, params):
    owner_id, device_id, parameter_id = (params.get(key) for key in ("trackId", "deviceId", "parameterId"))
    if not isinstance(owner_id, str) or not re.fullmatch(r"(?:track|return)-(?:0|[1-9][0-9]*)|master", owner_id):
        raise ValueError("canonical device owner required")
    if not isinstance(device_id, str) or not re.fullmatch(re.escape(owner_id) +
            r":device-(?:0|[1-9][0-9]*)(?:/(?:chain|return-chain)-(?:0|[1-9][0-9]*)/device-(?:0|[1-9][0-9]*))*", device_id):
        raise ValueError("canonical device path required")
    if not isinstance(parameter_id, str) or not re.fullmatch(r"parameter-(0|[1-9][0-9]*)", parameter_id):
        raise ValueError("canonical parameterId required")
    _, track = _device_owner(song, owner_id)
    _, _, device = _device(song, owner_id, device_id)
    index = int(parameter_id[10:])
    if not 0 < len(device.parameters) <= 2048 or index >= len(device.parameters):
        raise ValueError("parameter is unavailable or device exceeds 2048 controls")
    return track, device, index, device.parameters[index]


def _parameters(device):
    return [_parameter_record(parameter, index) for index, parameter in enumerate(device.parameters)]


def _same_topology(song, params, identity):
    try:
        track, device, _, _ = _resolve(song, params)
        return (track, device, tuple(device.parameters)) == identity
    except (ValueError, RuntimeError):
        return False


def source(song, params, version):
    global _song
    requested = _quantity(params.get("targetDisplay"))
    track, device, index, parameter = _resolve(song, params)
    if bool(getattr(track, "is_frozen", False)):
        raise ValueError("device owner is frozen")
    if getattr(parameter, "is_enabled", None) is not True or bool(getattr(parameter, "is_quantized", False)):
        raise ValueError("parameter must be enabled and continuous")
    if _parameter_automation_state(parameter) != {"value": 0, "name": "none"}:
        raise ValueError("parameter automation must be known and inactive")
    recording = {"arrangement": bool(song.record_mode), "session": bool(song.session_record)}
    if any(recording.values()):
        raise ValueError("resolve recording before changing a device parameter")
    if _song != song:
        _song = song
        _identities.clear()
    key, identity = (params["trackId"], params["deviceId"]), (track, device, tuple(device.parameters))
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    parameters = _parameters(device)
    digest = hashlib.sha256(json.dumps(parameters, sort_keys=True, allow_nan=False).encode()).hexdigest()
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": params["trackId"], "trackName": track.name, "deviceId": params["deviceId"],
            "deviceName": device.name, "deviceClass": device.class_name, "parameterId": params["parameterId"],
            "parameter": parameters[index], "parametersDigest": digest, "recording": recording,
            "requestedDisplay": params["targetDisplay"], "target": _target(parameter, requested)}


def apply(song, params, version):
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("device parameter context changed; review a fresh plan")
    track, device, index, parameter = _resolve(song, params)
    identity = (track, device, tuple(device.parameters))
    original, target = parameter.value, before["target"]["value"]
    previous = _parameters(device)
    observed = previous
    changed = original != target
    if changed:
        with _undo_step(song):
            try:
                parameter.value = target
                if not _same_topology(song, params, identity):
                    raise RuntimeError("native parameter topology changed during write")
                observed = _parameters(device)
                if not _same_topology(song, params, identity):
                    raise RuntimeError("native parameter topology changed during readback")
                selected = observed[index]
                if abs(selected["value"] - target) > 1e-6 or not _equal(_quantity(selected["displayValue"]), before["target"]["quantity"]) or \
                        selected["automationState"] != before["parameter"]["automationState"] or selected["enabled"] is not True:
                    raise RuntimeError("device parameter native readback mismatch")
            except Exception as error:
                if not _same_topology(song, params, identity):
                    raise RuntimeError(f"device parameter failed: {error}; restoration skipped because native topology changed; inspect current device") from error
                try:
                    parameter.value = original
                    if not _same_topology(song, params, identity) or parameter.value != original:
                        raise RuntimeError("original parameter value was not restored")
                except Exception as rollback_error:
                    raise RuntimeError(f"device parameter failed: {error}; rollback failed: {rollback_error}") from error
                raise
    return {"stateVersion": version + 1, "trackId": params["trackId"], "deviceId": params["deviceId"],
            "parameterId": params["parameterId"], "changed": changed, "verified": True, "parameter": observed[index],
            "dependentChanges": [{"before": old, "after": new} for position, (old, new) in enumerate(zip(previous, observed))
                                 if position != index and old != new]}
