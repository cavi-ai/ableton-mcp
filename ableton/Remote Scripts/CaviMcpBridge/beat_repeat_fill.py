"""Temporary Repeat ownership, released on Live display ticks without a client."""
import math
import time
import uuid

try:
    from .bridge import (_track, _device, _beat_repeat_performance_context,
                         _parameter_automation_state, _set_fingerprint)
except ImportError:
    from bridge import (_track, _device, _beat_repeat_performance_context,
                        _parameter_automation_state, _set_fingerprint)

_fills = {}
_sources = {}


def _location(song, track, target):
    index = next((i for i, candidate in enumerate(song.tracks) if candidate == track), None)
    if index is None:
        return None
    count = [0]

    def visit(owner, prefix, depth):
        if depth > 16:
            raise ValueError("fill device traversal exceeds 16 rack levels")
        for position, device in enumerate(owner.devices):
            count[0] += 1
            if count[0] > 512:
                raise ValueError("fill device traversal exceeds 512 devices")
            device_id = f"{prefix}:device-{position}" if depth == 0 else f"{prefix}/device-{position}"
            if device == target:
                return owner, f"track-{index}", device_id
            if bool(getattr(device, "can_have_chains", False)):
                for kind, chains in (("chain", device.chains), ("return-chain", getattr(device, "return_chains", ()))):
                    for chain_index, chain in enumerate(chains):
                        found = visit(chain, f"{device_id}/{kind}-{chain_index}", depth + 1)
                        if found:
                            return found
        return None
    return visit(track, f"track-{index}", 0)


def _recording(song, track):
    return bool(song.record_mode or song.session_record or any(
        slot.has_clip and bool(getattr(slot.clip, "is_recording", False)) for slot in track.clip_slots))


def source(song, params, version):
    _, track = _track(song, params["trackId"])
    owner, _, device = _device(song, params["trackId"], params["deviceId"])
    if not song.is_playing:
        raise ValueError("start authorized playback before a temporary Repeat fill")
    if _recording(song, track):
        raise ValueError("temporary Repeat fills require recording off on the source")
    if bool(getattr(track, "is_frozen", True)):
        raise ValueError("temporary Repeat fills require an unfrozen source")
    before = _beat_repeat_performance_context(song, params["trackId"], params["deviceId"], version)
    repeat = before["controls"]["Repeat"]
    if not before["device"]["active"] or not repeat["enabled"] or (repeat["automationState"] or {}).get("value") != 0:
        raise ValueError("Repeat must be active, enabled and free of automation")
    if not repeat["quantized"] or repeat["valueItems"] != ["Off", "On"] or repeat["min"] != 0 or repeat["max"] != 1:
        raise ValueError("native Repeat Off/On mapping is unavailable")
    if repeat["value"] != 0 or repeat["displayValue"] != "Off":
        raise ValueError("Repeat must start Off; inspect existing fills before retrying")
    parameter = device.parameters[int(repeat["id"].removeprefix("parameter-"))]
    if not all(callable(getattr(parameter, method, None)) for method in ("add_value_listener", "remove_value_listener")):
        raise ValueError("native Repeat change observation is unavailable")
    if _location(song, track, device) != (owner, params["trackId"], params["deviceId"]):
        raise ValueError("native Repeat owner changed")
    key = (params["trackId"], params["deviceId"])
    identity = (song, track, owner, device, parameter, tuple(device.parameters))
    cached = _sources.get(key)
    if cached is None or cached[0] != identity:
        if len(_sources) >= 64:
            _sources.pop(next(iter(_sources)))
        cached = (identity, str(uuid.uuid4()))
        _sources[key] = cached
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": params["trackId"], "deviceId": params["deviceId"], "before": before}


def _owned(record, song):
    if record["song"] != song:
        raise RuntimeError("fill Set changed")
    location = _location(song, record["track"], record["device"])
    if location is None or location[0] != record["owner"]:
        raise RuntimeError("fill device was removed, replaced or moved to another owner")
    parameters = list(record["device"].parameters)
    matches = [p for p in parameters if p.original_name == "Repeat"]
    if len(matches) != 1 or matches[0] != record["parameter"]:
        raise RuntimeError("fill Repeat parameter identity changed")
    return location


def _detach(record):
    callback = record.get("listener")
    if callback is not None:
        try:
            record["parameter"].remove_value_listener(callback)
            record["listener"] = None
        except Exception as error:
            record["cleanupErrors"].append(f"Repeat listener cleanup: {error}")


def _end(record, song, status, reason, now=None):
    record.update(reason=reason, elapsedSeconds=max(0, (time.monotonic() if now is None else now) - record["started"]),
                  releaseVerified=False)
    try:
        _owned(record, song)
        parameter = record["parameter"]
        if record["manualChanged"]:
            record["status"] = "superseded"
        else:
            if _recording(song, record["track"]) or (_parameter_automation_state(parameter) or {}).get("value") != 0:
                raise RuntimeError("recording or automation changed; Repeat release is unverified")
            if not parameter.is_enabled:
                raise RuntimeError("native Repeat became disabled")
            record["writing"] = True
            try:
                parameter.value = 0
            finally:
                record["writing"] = False
            if parameter.value != 0 or parameter.str_for_value(parameter.value) != "Off":
                raise RuntimeError("native Repeat Off readback did not match")
            record.update(status=status, releaseVerified=True)
    except Exception as error:
        record["status"] = "cleanup_failed"
        record["cleanupErrors"].append(str(error))
    _detach(record)
    if record["cleanupErrors"]:
        record["status"] = "cleanup_failed"


def has_active():
    return any(record["status"] == "active" for record in _fills.values())


def advance(song, now=None):
    now = time.monotonic() if now is None else now
    changed = 0
    for record in list(_fills.values()):
        if record["status"] != "active":
            continue
        reason = None
        try:
            _owned(record, song)
            if record["manualChanged"]:
                reason = "Repeat was edited outside this fill"
            elif not song.is_playing or _recording(song, record["track"]):
                reason = "source playback or recording changed"
        except Exception as error:
            reason = str(error)
        if reason is not None or now >= record["deadline"]:
            _end(record, song, "interrupted" if reason else "complete", reason or "requested duration elapsed", now)
            changed += 1
    return changed


def shutdown(song):
    for record in list(_fills.values()):
        if record["status"] == "active":
            _end(record, song, "interrupted", "bridge disconnected")
        elif record.get("listener") is not None:
            _detach(record)


def read(song, params, version):
    # Handles belong to one live document and bridge instance, not a saved Set.
    if "fillId" not in params:
        for key, record in list(_fills.items()):
            if record["song"] != song and record["status"] != "active" and record.get("listener") is None:
                del _fills[key]
        return {"stateVersion": version, "fills": [read(song, {"fillId": key}, version) for key in list(_fills)]}
    record = _fills.get(params["fillId"])
    if record is None:
        raise ValueError("fill handle is unavailable; inspect actual Repeat state before retrying")
    location, off = None, False
    try:
        location = _owned(record, song)
        parameter = record["parameter"]
        off = parameter.value == 0 and parameter.str_for_value(parameter.value) == "Off"
    except Exception:
        pass
    return {"stateVersion": version, "fillId": params["fillId"], "setFingerprint": record["setFingerprint"],
            "trackId": location[1] if location else None, "deviceId": location[2] if location else None,
            "status": record["status"], "reason": record.get("reason"), "durationSeconds": record["duration"],
            "elapsedSeconds": record.get("elapsedSeconds"), "releaseVerified": record.get("releaseVerified"),
            "repeatOffObserved": off, "cleanupErrors": list(record["cleanupErrors"]),
            "timingBasis": "wall-clock duration checked on Live display ticks; not beat-scheduled or real-time guaranteed"}


def start(song, params, version):
    duration = params.get("durationSeconds")
    if type(duration) not in (int, float) or not math.isfinite(duration) or not .25 <= duration <= 8:
        raise ValueError("fill duration must be between 0.25 and 8 seconds")
    if params.get("expectedStateVersion") != version or source(song, params, version) != params.get("before"):
        raise ValueError("fill source identity, controls or state changed")
    read(song, {}, version)
    if len(_fills) >= 16 or sum(r["status"] == "active" for r in _fills.values()) >= 4:
        raise ValueError("finish retained fills; at most 16 handles and four active fills are supported")
    _, track = _track(song, params["trackId"])
    owner, _, device = _device(song, params["trackId"], params["deviceId"])
    parameter = device.parameters[int(params["before"]["before"]["controls"]["Repeat"]["id"].removeprefix("parameter-"))]
    if any(r["device"] == device and r["status"] == "active" for r in _fills.values()):
        raise ValueError("this device already has an active fill")
    key, now = str(uuid.uuid4()), time.monotonic()
    record = {"song": song, "track": track, "owner": owner, "device": device, "parameter": parameter,
              "setFingerprint": _set_fingerprint(song), "status": "active", "duration": duration,
              "started": now, "deadline": now + duration, "writing": False, "manualChanged": False, "cleanupErrors": []}

    def changed():
        if not record["writing"] and parameter.value != 1:
            record["manualChanged"] = True
    record["listener"] = changed
    _fills[key] = record
    try:
        parameter.add_value_listener(changed)
        record["writing"] = True
        try:
            parameter.value = 1
        finally:
            record["writing"] = False
        if parameter.value != 1 or parameter.str_for_value(parameter.value) != "On":
            raise RuntimeError("native Repeat On readback did not match")
    except Exception as error:
        _end(record, song, "failed", str(error))
        raise RuntimeError(f"fill start failed; inspect fill {key}: {error}; cleanup: {record['cleanupErrors']}") from error
    return read(song, {"fillId": key}, version + 1)


def finish(song, params, version):
    if params.get("expectedStateVersion") != version or read(song, params, version) != params.get("before"):
        raise ValueError("fill handle or state changed; read before retrying")
    if type(params.get("cancel", False)) is not bool:
        raise ValueError("fill cancel must be boolean")
    record = _fills[params["fillId"]]
    if record["status"] == "active":
        if not params.get("cancel", False):
            raise ValueError("fill is active; cancel explicitly to end early")
        _end(record, song, "cancelled", "cancelled before duration elapsed")
        if record["status"] == "cleanup_failed":
            raise RuntimeError(f"Repeat release failed; inspect fill {params['fillId']}: {record['cleanupErrors']}")
    if record.get("listener") is not None:
        _detach(record)
        if record.get("listener") is not None:
            raise RuntimeError(f"Repeat listener cleanup is incomplete; retain fill {params['fillId']} for retry")
    result = {**read(song, params, version + 1), "handleReleased": True}
    del _fills[params["fillId"]]
    return result
