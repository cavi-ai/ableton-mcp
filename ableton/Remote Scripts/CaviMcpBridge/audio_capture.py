"""Bounded Resampling recordings with cleanup independent of MCP clients."""
import math
import os
import time
import uuid

try:
    from .bridge import _set_fingerprint, _routing_option, _current_routing_option, _undo_step
except ImportError:
    from bridge import _set_fingerprint, _routing_option, _current_routing_option, _undo_step

_captures = {}
_document = (None, None)
_running = ("recording", "stopping", "finalizing")


def _prune(song):
    for key, record in list(_captures.items()):
        try:
            missing = record["song"] != song or record["track"] not in song.tracks
        except Exception:
            missing = True
        if missing:
            del _captures[key]


def source(song, params, version):
    global _document
    if not song.is_playing:
        raise ValueError("start authorized playback before capturing Live audio")
    if song.record_mode or song.session_record:
        raise ValueError("stop existing recording before capturing Live audio")
    if any(getattr(track, "can_be_armed", True) and bool(track.arm) for track in song.tracks):
        raise ValueError("resolve armed tracks explicitly before capturing Live audio")
    if any(bool(getattr(slot.clip, "is_recording", False))
           for track in song.tracks for slot in getattr(track, "clip_slots", ()) if slot.has_clip):
        raise ValueError("stop existing clip recording before capturing Live audio")
    if _document[0] != song:
        _document = (song, str(uuid.uuid4()))
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "documentId": _document[1],
            "tempo": float(song.tempo), "isPlaying": True, "recording": False,
            "tracks": [{"name": track.name, "isGroup": bool(getattr(track, "is_foldable", False))}
                       for track in song.tracks]}


def _clip_path(clip):
    try:
        return getattr(clip, "file_path", None) if clip is not None else None
    except Exception:
        return None


def _file(clip):
    path = _clip_path(clip)
    if not path:
        return None
    path = os.path.realpath(path)
    try:
        info = os.stat(path)
        if not os.path.isfile(path) or info.st_size <= 0:
            return None
        return {"path": path, "size": info.st_size, "mtimeNs": str(info.st_mtime_ns)}
    except OSError:
        return None


def _end(record, status, reason):
    errors, pending = [], []
    track, slot = record["track"], record["slot"]
    try:
        if record["clip"] is None and slot.has_clip and bool(getattr(slot.clip, "is_recording", False)):
            record["clip"] = slot.clip
        if record["clip"] is not None:
            clip = record["clip"]
            clip.stop()
            if bool(getattr(clip, "is_recording", False)) or bool(clip.is_playing):
                pending.append("capture clip did not stop")
        elif record["clip"] is None and bool(getattr(slot, "is_triggered", False)):
            slot.stop()
            if bool(getattr(slot, "is_triggered", False)):
                pending.append("pending capture launch did not stop")
    except Exception as error:
        errors.append(str(error))
    try:
        track.arm = False
        if track.arm:
            raise RuntimeError("capture track remains armed")
    except Exception as error:
        errors.append(str(error))
    record.update(status="cleanup_failed" if errors else status, reason=reason, cleanupErrors=errors)
    if pending and not errors:
        record.update(status="stopping", stopTarget=status, stopDeadline=time.monotonic() + 3)


def _settle_stop(record, now):
    try:
        clip = record["clip"]
        slot = record["slot"]
        if clip is None and slot.has_clip:
            candidate = slot.clip
            if bool(getattr(candidate, "is_recording", False)):
                record["clip"] = clip = candidate
                clip.stop()
            elif bool(getattr(candidate, "is_playing", False)):
                raise RuntimeError("pending capture slot changed before stop was confirmed")
        if clip is not None:
            active = bool(getattr(clip, "is_recording", False)) or bool(getattr(clip, "is_playing", False))
        else:
            active = bool(getattr(record["slot"], "is_triggered", False))
        if record["track"].arm:
            raise RuntimeError("capture track remains armed")
        if not active:
            record["status"] = record["stopTarget"]
        elif now >= record["stopDeadline"]:
            raise RuntimeError("capture stop was not confirmed within three seconds")
    except Exception as error:
        record.update(status="cleanup_failed", cleanupErrors=[str(error)])


def _other_recording(song, capture_track):
    for track in song.tracks:
        if track == capture_track:
            continue
        if getattr(track, "can_be_armed", True) and bool(track.arm):
            return True
        if any(bool(getattr(slot.clip, "is_recording", False))
               for slot in getattr(track, "clip_slots", ()) if slot.has_clip):
            return True
    return False


def has_active():
    return any(record["status"] in _running for record in _captures.values())


def advance(song, now=None):
    """Called by the Live main-thread display tick, including with no requests."""
    _prune(song)
    changed = 0
    now = time.monotonic() if now is None else now
    for record in list(_captures.values()):
        if record["status"] not in _running:
            continue
        old = record["status"]
        try:
            track, slot = record["track"], record["slot"]
            if record["status"] == "stopping":
                _settle_stop(record, now)
            elif now >= record["deadline"]:
                _end(record, "timed_out", "capture exceeded its wall-clock deadline")
            elif record["status"] == "finalizing":
                if track.arm or not slot.has_clip or slot.clip != record["clip"] or bool(getattr(record["clip"], "is_recording", False)):
                    _end(record, "interrupted", "capture changed before its file stabilized")
                    changed += 1
                    continue
                current = _file(record["clip"])
                if current and current == record.get("lastFile"):
                    record.update(status="file_ready", file=current)
                record["lastFile"] = current
            elif not song.is_playing or song.record_mode or float(song.tempo) != record["tempo"] or _other_recording(song, track):
                _end(record, "interrupted", "source playback or recording mode changed")
            elif not track.arm or not track.mute or track.solo or int(track.current_monitoring_state) != 2 or \
                    _current_routing_option(track.current_input_routing, track.available_input_routing_types) != record["input"]:
                _end(record, "interrupted", "capture controls changed")
            elif slot.has_clip:
                clip = slot.clip
                if record["clip"] is None and bool(getattr(clip, "is_recording", False)):
                    record["clip"] = clip
                if clip != record["clip"]:
                    _end(record, "interrupted", "capture clip was replaced or recording was not observed")
                elif not bool(getattr(clip, "is_recording", False)):
                    _end(record, "finalizing", "fixed-length recording ended")
            elif record["clip"] is not None:
                _end(record, "interrupted", "capture clip was removed")
        except Exception as error:
            _end(record, "interrupted", str(error))
        changed += int(record["status"] != old)
    return changed


def shutdown(song):
    _prune(song)
    for record in _captures.values():
        if record["status"] in _running:
            _end(record, "interrupted", "bridge disconnected")
            if record["status"] == "stopping":
                record.update(status="cleanup_failed", cleanupErrors=["bridge disconnected before capture stop was confirmed"])


def read(song, params, version):
    _prune(song)
    if "captureId" not in params:
        return {"stateVersion": version, "captures": [read(song, {"captureId": key}, version) for key in list(_captures)]}
    key = params["captureId"]
    record = _captures.get(key)
    if record is None:
        raise ValueError("Live audio capture is unavailable in this document or bridge instance; inspect retained tracks")
    track = record["track"]
    index = next(i for i, candidate in enumerate(song.tracks) if candidate == track)
    try:
        clip_id = next((f"track-{index}:clip-{i}" for i, slot in enumerate(track.clip_slots)
                        if slot.has_clip and slot.clip == record["clip"]), None)
    except Exception:
        clip_id = None
    file = record.get("file")
    try:
        unchanged = bool(file and clip_id and not bool(getattr(record["clip"], "is_recording", False)) and _file(record["clip"]) == file)
    except Exception:
        unchanged = False
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "captureId": key,
            "status": record["status"], "reason": record.get("reason"), "beats": record["beats"],
            "expectedDurationSeconds": record["seconds"],
            "trackId": f"track-{index}", "clipId": clip_id, "name": track.name,
            "mute": bool(track.mute), "armed": bool(track.arm), "monitoring": int(track.current_monitoring_state),
            "file": file, "fileUnchanged": unchanged if file else None,
            "partialSourcePath": _clip_path(record["clip"]) if not file else None,
            "cleanupErrors": record["cleanupErrors"],
            "scope": "Live Resampling input over the capture window; not isolated tracks, hardware output or listener confirmation."}


def start(song, params, version):
    if params.get("expectedStateVersion") != version:
        raise ValueError("audio capture state version changed")
    before = source(song, {}, version)
    if before != params.get("before"):
        raise ValueError("audio capture source or controls changed")
    beats, name = params.get("beats"), params.get("name")
    if type(beats) not in (int, float) or not math.isfinite(beats) or not 1 <= beats <= 16:
        raise ValueError("capture beats must be between 1 and 16")
    seconds = beats * 60 / before["tempo"] if before["tempo"] > 0 else float("inf")
    if not 0.5 <= seconds <= 30:
        raise ValueError("capture must last between 0.5 and 30 seconds at the observed tempo")
    if not isinstance(name, str) or not name.strip() or len(name) > 128:
        raise ValueError("capture name must contain 1-128 characters")
    _prune(song)
    if len(_captures) >= 16:
        raise ValueError("finish an existing audio capture before creating another; at most 16 handles are retained")
    old_tracks, created, issued = list(song.tracks), None, False
    key, record = str(uuid.uuid4()), None
    with _undo_step(song):
        try:
            try:
                song.create_audio_track(len(old_tracks))
            finally:
                added = [track for track in song.tracks if track not in old_tracks]
                if len(added) == 1:
                    created = added[0]
            if created is None or song.tracks[-1] != created or list(song.tracks[:-1]) != old_tracks:
                raise RuntimeError("capture track insertion readback mismatch")
            created.name, created.mute, created.solo = name, True, False
            created.arm, created.current_monitoring_state = False, 2
            choices = [_routing_option(choice) for choice in created.available_input_routing_types]
            inputs = [choice for choice in choices if choice["name"] == "Resampling"]
            if len(inputs) != 1:
                raise ValueError("one unambiguous native Resampling input is required")
            created.current_input_routing = inputs[0]["name"]
            slot = created.clip_slots[0]
            if slot.has_clip or bool(getattr(slot, "is_triggered", False)):
                raise RuntimeError("new capture slot is not empty")
            created.arm = True
            if not created.mute or created.solo or not created.arm or int(created.current_monitoring_state) != 2 or \
                    _current_routing_option(created.current_input_routing, created.available_input_routing_types) != inputs[0]:
                raise RuntimeError("capture safety controls readback mismatch")
            record = {"song": song, "track": created, "slot": slot, "clip": None, "input": inputs[0],
                      "status": "recording", "beats": beats, "seconds": seconds, "tempo": before["tempo"],
                      "deadline": time.monotonic() + seconds + 3,
                      "cleanupErrors": []}
            _captures[key] = record
            issued = True
            slot.fire(record_length=beats, launch_quantization=0)
            if slot.has_clip and bool(getattr(slot.clip, "is_recording", False)):
                record["clip"] = slot.clip
        except Exception as error:
            if issued:
                _end(record, "failed", str(error))
                raise RuntimeError(f"capture failed; inspect capture {key}: {error}; cleanup errors: {record['cleanupErrors']}") from error
            if created is not None:
                try:
                    created.arm = False
                    song.delete_track(next(i for i, track in enumerate(song.tracks) if track == created))
                    if created in song.tracks:
                        raise RuntimeError("new capture track remains")
                except Exception as cleanup:
                    raise RuntimeError(f"capture preparation failed: {error}; cleanup incomplete: {cleanup}") from error
            raise
    return read(song, {"captureId": key}, version + 1)


def finish(song, params, version):
    if params.get("expectedStateVersion") != version:
        raise ValueError("audio capture state version changed")
    before = read(song, params, version)
    if before != params.get("before"):
        raise ValueError("audio capture changed; read its current state")
    if type(params.get("cancel", False)) is not bool:
        raise ValueError("capture cancel must be boolean")
    record = _captures[params["captureId"]]
    if record["status"] in _running or record["cleanupErrors"]:
        if not params.get("cancel", False):
            raise ValueError("capture is still in progress; cancel explicitly to end early")
        if record["status"] != "stopping":
            _end(record, "cancelled", "cancelled before completion")
    if record["cleanupErrors"]:
        raise RuntimeError("capture cleanup incomplete: " + "; ".join(record["cleanupErrors"]))
    if record["status"] == "stopping":
        return {**read(song, params, version + 1), "captureActive": True}
    result = {**read(song, params, version + 1), "captureActive": False}
    del _captures[params["captureId"]]
    return result
