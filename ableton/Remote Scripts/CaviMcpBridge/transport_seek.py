"""Guard absolute transport seeks and report partial native writes."""
import math
import uuid
try:
    from .bridge import _transport_recording_context, _undo_step
except ImportError:
    from bridge import _transport_recording_context, _undo_step

_binding = None
_token = None
_FIELDS = (("currentSongTime", "current_song_time"), ("metronome", "metronome"), ("automationArm", "session_automation_record"))
_GROUPS = {"arrangement":(("overdub", "arrangement_overdub"), ("punchIn", "punch_in"), ("punchOut", "punch_out"), ("backToArranger", "back_to_arranger"), ("record", "record_mode")),
           "session":(("overdub", "overdub"), ("record", "session_record"))}


def _owners(song):
    tracks = tuple(song.tracks)
    if len(tracks) > 256:
        raise ValueError("transport seeks support at most 256 tracks including Groups")
    return song, tracks


def _safe(song):
    for flag in ("record_mode", "session_record", "is_counting_in"):
        if getattr(song, flag, None) is not False:
            raise ValueError("finish recording with a separate mode-only request before seeking; recording and count-in must be known inactive")
    count = 0
    for track in song.tracks:
        if getattr(track, "is_foldable", False):
            continue
        slots, arrangement = tuple(track.clip_slots), tuple(track.arrangement_clips)
        count += len(slots)+len(arrangement)
        if count > 16384:
            raise ValueError("transport seek recording inspection exceeds its clip bound")
        clips = [slot.clip for slot in slots if slot.has_clip]+list(arrangement)
        if any(getattr(clip, "is_recording", None) is not False for clip in clips):
            raise ValueError("clip recording must be known inactive before seeking")


def context(song, params, version):
    global _binding, _token
    owners = _owners(song)
    _safe(song)
    if _binding != owners:
        _binding, _token = owners, str(uuid.uuid4())
    transport = _transport_recording_context(song, version)
    del transport["stateVersion"]
    if transport["isPlaying"]:
        del transport["currentSongTime"]
    if _owners(song) != owners:
        raise ValueError("Set or tracks changed during seek inspection")
    return {"stateVersion":version, "identityToken":_token, "transport":transport}


def _changes(params):
    changes = params.get("changes")
    if not isinstance(changes, dict) or "currentSongTime" not in changes or set(changes)-{"currentSongTime", "metronome", "automationArm", "arrangement", "session"}:
        raise ValueError("explicit supported absolute seek changes required")
    time = changes["currentSongTime"]
    if type(time) not in (int, float) or not math.isfinite(time) or not 0 <= time <= 9007199254740991:
        raise ValueError("currentSongTime must be a finite nonnegative beat position")
    for name, value in changes.items():
        if name in _GROUPS:
            if not isinstance(value, dict) or set(value)-{key for key, _ in _GROUPS[name]} or any(type(v) is not bool for v in value.values()):
                raise ValueError("supported boolean recording fields required")
        elif name != "currentSongTime" and type(value) is not bool:
            raise ValueError("transport flags must be boolean")
    return changes


def _writes(changes):
    result = [(key, attr, changes[key]) for key, attr in _FIELDS if key in changes]
    # Recording commands follow the seek and requested preparation controls.
    for group in ("arrangement", "session"):
        result += [(group+"."+key, attr, changes[group][key]) for key, attr in _GROUPS[group] if key != "record" and key in changes.get(group, {})]
    for group in ("arrangement", "session"):
        if "record" in changes.get(group, {}):
            result.append((group+".record", dict(_GROUPS[group])["record"], changes[group]["record"]))
    return result


def _forward_guard(song, operation, version):
    if _owners(song) != operation["owners"]:
        raise ValueError("Set or tracks changed during transport seek")
    issued = {r["field"] for r in operation["writes"]}
    started = any(r["field"] in ("arrangement.record", "session.record") and r["requestedValue"] is True for r in operation["writes"])
    if not started:
        _safe(song)
    actual = _transport_recording_context(song, version)
    before = operation["before"]["transport"]
    for key, value in before.items():
        if key == "currentSongTime" or key in issued or (key == "isPlaying" and started):
            continue
        if key in _GROUPS:
            if any(actual[key][field] != prior for field, prior in value.items() if key+"."+field not in issued):
                raise ValueError("unrequested recording controls changed during transport seek")
        elif actual[key] != value:
            raise ValueError("unrequested transport controls changed during seek")


def begin(song, params, version):
    changes = _changes(params)
    before = context(song, {}, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("Set or transport seek context changed after planning")
    owners = _owners(song)
    operation = {"before":before, "owners":owners, "changes":changes, "writes":[], "error":None}
    writes = _writes(changes)
    if all(getattr(song, attr) == value for _, attr, value in writes):
        return operation
    try:
        with _undo_step(song):
            if context(song, {}, version) != before or _owners(song) != owners:
                raise ValueError("transport seek context changed before write")
            for field, attr, value in writes:
                _forward_guard(song, operation, version)
                if getattr(song, attr) == value:
                    continue
                record = {"field":field, "requestedValue":value, "nativeReturned":False}
                operation["writes"].append(record)
                setattr(song, attr, value)
                record["nativeReturned"] = True
    except Exception as failure:
        if not operation["writes"]:
            raise
        operation["error"] = (str(failure) or failure.__class__.__name__)[:600]
    return operation


def _receipt(operation, version):
    seek = next((r for r in operation["writes"] if r["field"] == "currentSongTime"), None)
    return {"stateVersion":version, "seek":{"requestedBeats":operation["changes"]["currentSongTime"],
            "writeRequested":seek is not None, "nativeReturned":seek["nativeReturned"] if seek else False},
            "writes":operation["writes"], "nativeReturned":bool(operation["writes"]) and all(r["nativeReturned"] for r in operation["writes"]),
            "targetRetained":False, "observed":None, "error":operation["error"],
            "verification":{"controlsConfirmed":False, "controlFieldsConfirmed":False, "positionVerified":False,
                            "unverifiedFields":["currentSongTime"], "mismatches":[], "scope":"Native control readback only; playing position, recorded content and audible output are not verified."},
            "limitation":"Partial writes remain. No automatic rollback, playhead restoration or replay. Recording commands may start playback and capture content."}


def unobserved(operation, version, error):
    return {**_receipt(operation, version), "observationError":(str(error) or error.__class__.__name__)[:600]}


def complete(song, operation, version):
    result = _receipt(operation, version)
    try:
        observed = _transport_recording_context(song, version)
        retained = _owners(song) == operation["owners"]
        mismatches = []
        for field, _, value in _writes(operation["changes"]):
            if field == "currentSongTime":
                continue
            parts = field.split(".")
            actual = observed[parts[0]][parts[1]] if len(parts) == 2 else observed[field]
            if actual != value:
                mismatches.append(field)
        playing = operation["before"]["transport"]["isPlaying"] or observed["isPlaying"]
        position = not playing and abs(observed["currentSongTime"]-operation["changes"]["currentSongTime"]) <= 1e-6
        accepted = operation["error"] is None and all(r["nativeReturned"] for r in operation["writes"])
        fields = retained and accepted and not mismatches
        if not playing and not position:
            mismatches.append("currentSongTime")
        result.update(targetRetained=retained, observed=observed)
        result["verification"].update(controlsConfirmed=fields and position, controlFieldsConfirmed=fields,
                                      positionVerified=retained and accepted and position,
                                      unverifiedFields=["currentSongTime"] if playing else [], mismatches=mismatches)
    except Exception as failure:
        result["observationError"] = (str(failure) or failure.__class__.__name__)[:600]
    return result


def seek(song, params, version):
    return complete(song, begin(song, params, version), version+1)
