"""Native Simpler sample inspection and explicit file replacement."""
import os
import uuid

try:
    from .bridge import _track, _device, _device_record, _track_record, _parameter_record, _transport_recording_context, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _track, _device, _device_record, _track_record, _parameter_record, _transport_recording_context, _set_fingerprint, _undo_step

MODES = ("classic", "one-shot", "slicing")
_song = None
_identities = {}


def _objects(song, params):
    index, track = _track(song, params["trackId"])
    owner, _, device = _device(song, params["trackId"], params["deviceId"])
    if not track.has_midi_input or device.class_name != "OriginalSimpler":
        raise ValueError("an existing Simpler on an ordinary MIDI track is required")
    return index, track, owner, device


def _optional(item, name, convert):
    try:
        return convert(getattr(item, name))
    except (AttributeError, RuntimeError):
        return None


def _sample_record(sample):
    if sample is None:
        return None
    slices = _optional(sample, "slices", list)
    if slices is not None and len(slices) > 4096:
        raise ValueError("Simpler sample inspection supports at most 4096 slices")
    markers = _optional(sample, "warp_markers", list)
    if markers is not None and len(markers) > 4096:
        raise ValueError("Simpler sample inspection supports at most 4096 warp markers")
    controls = {name: _optional(sample, name, kind) for name, kind in (
        ("beats_granulation_resolution", int), ("beats_transient_envelope", float), ("beats_transient_loop_mode", int),
        ("complex_pro_envelope", float), ("complex_pro_formants", float), ("texture_flux", float),
        ("texture_grain_size", float), ("tones_grain_size", float), ("slicing_sensitivity", float),
        ("slicing_style", int), ("slicing_beat_division", int), ("slicing_region_count", int))}
    return {"path": sample.file_path, "lengthFrames": int(sample.length),
            "sampleRate": _optional(sample, "sample_rate", int),
            "startMarkerFrames": int(sample.start_marker), "endMarkerFrames": int(sample.end_marker),
            "gain": float(sample.gain), "warping": bool(sample.warping), "warpMode": int(sample.warp_mode),
            "slicesFrames": [int(value) for value in slices] if slices is not None else None,
            "nativeControls": controls,
            "warpMarkers": {"supported": markers is not None, "sampleTimeUnit": "native-unverified", "markers": [
                {"sampleTime": float(marker.sample_time), "beatTime": float(marker.beat_time)} for marker in markers
            ] if markers is not None else None}}


def source(song, params, version):
    global _song
    index, track, owner, device = _objects(song, params)
    if len(device.parameters) > 512:
        raise ValueError("Simpler sample inspection supports at most 512 parameters")
    sample = device.sample
    identity = (tuple(song.tracks), track, owner, device, sample, tuple(device.parameters))
    key = (params["trackId"], params["deviceId"])
    if _song != song:
        _song = song
        _identities.clear()
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    recording = _transport_recording_context(song, version)
    del recording["currentSongTime"]
    row = _track_record(song, track, index)
    row.update(frozen=bool(track.is_frozen), monitoring=int(track.current_monitoring_state),
               firedSlotIndex=int(track.fired_slot_index))
    mode = int(device.playback_mode)
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song),
            "trackId": params["trackId"], "deviceId": params["deviceId"],
            "identityToken": cached[1], "device": _device_record(device, params["deviceId"]), "track": row,
            "canReplaceSample": callable(getattr(device, "replace_sample", None)),
            "multiSampleMode": bool(device.multi_sample_mode),
            "playbackMode": {"value": mode, "name": MODES[mode] if 0 <= mode < len(MODES) else None},
            "nativeControls": {name: _optional(device, name, kind) for name, kind in (
                ("pad_slicing", bool), ("slicing_playback_mode", int), ("retrigger", bool), ("voices", int))},
            "playingPositionEnabled": bool(device.playing_position_enabled), "sample": _sample_record(sample),
            "parameters": [_parameter_record(parameter, i) for i, parameter in enumerate(device.parameters)],
            "recording": recording}


def _file(path):
    if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
        raise ValueError("sourcePath must reference an absolute regular audio file")
    info = os.stat(path)
    return {"size": str(info.st_size), "mtimeNs": str(info.st_mtime_ns),
            "device": str(info.st_dev), "inode": str(info.st_ino)}


def load(song, params, version):
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version:
        raise ValueError("Simpler sample state version changed")
    allow_replace, mode = params.get("allowReplace", False), params.get("playbackMode")
    if type(allow_replace) is not bool or mode is not None and (type(mode) is not int or not 0 <= mode < len(MODES)):
        raise ValueError("invalid allowReplace or playbackMode")
    target = {"trackId": params["trackId"], "deviceId": params["deviceId"]}
    before = source(song, target, version)
    if before != params.get("before"):
        raise ValueError("Simpler sample context changed; review a fresh plan")
    if before["sample"] is not None and not allow_replace:
        raise ValueError("allowReplace is required for an existing sample")
    row, recording = before["track"], before["recording"]
    if before["multiSampleMode"] or not before["canReplaceSample"]:
        raise ValueError("single-sample Simpler replacement is unavailable")
    if (row["frozen"] or row["armed"] or row["monitoring"] == 0 or row["firedSlotIndex"] >= 0 or
            recording["isPlaying"] or recording["arrangement"]["record"] or recording["session"]["record"] or
            before["playingPositionEnabled"]):
        raise ValueError("Simpler sample loading requires stopped transport, no recording, and an inactive unarmed target without input monitoring or pending launches")
    path = params["sourcePath"]
    if _file(path) != params.get("sourceFile"):
        raise ValueError("source file changed after planning")
    _, track, owner, device = _objects(song, target)
    identity = (tuple(song.tracks), track, owner, device)
    with _undo_step(song):
        try:
            device.replace_sample(path)
            _, current_track, current_owner, current_device = _objects(song, target)
            if (tuple(song.tracks), current_track, current_owner, current_device) != identity:
                raise RuntimeError("Simpler ownership changed during replacement")
            if mode is not None:
                device.playback_mode = mode
            after = source(song, target, version + 1)
            _, current_track, current_owner, current_device = _objects(song, target)
            if (tuple(song.tracks), current_track, current_owner, current_device) != identity:
                raise RuntimeError("Simpler ownership changed during readback")
            sample = after["sample"]
            if (sample is None or os.path.realpath(sample["path"]) != os.path.realpath(path) or sample["lengthFrames"] <= 0 or
                    not sample["sampleRate"] or sample["sampleRate"] <= 0 or
                    not 0 <= sample["startMarkerFrames"] < sample["endMarkerFrames"] <= sample["lengthFrames"] or
                    mode is not None and after["playbackMode"]["value"] != mode or _file(path) != params["sourceFile"]):
                raise RuntimeError("Simpler sample readback mismatch")
        except Exception as error:
            raise RuntimeError(f"Simpler sample load may be partial: {error}; inspect the device and file before retrying. No sample-state rollback was attempted.") from error
    return {"stateVersion": version + 1, **target, "verified": True, "sample": sample,
            "playbackMode": after["playbackMode"], "context": after,
            "limitation": "Verified exposed sample path, frame bounds, rate and requested mode; file metadata is guarded, not decoded bytes or cache identity. Replacement can reset sample-derived settings. Hidden state, slices and automation are not backed up or restored; inspect and audition separately."}
