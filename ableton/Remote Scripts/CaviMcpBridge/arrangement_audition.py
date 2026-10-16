"""Guarded loop playback with scoped Single Track Back to Arrangement writes."""
import math
import re
import uuid

try:
    from .bridge import _track, _track_record, _arrangement_clip_record, _set_fingerprint, _transport_recording_context
except ImportError:
    from bridge import _track, _track_record, _arrangement_clip_record, _set_fingerprint, _transport_recording_context

_document = (None, None)


def _request(song, params):
    start, end, ids = params.get("startBeats"), params.get("endBeats"), params.get("trackIds")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end)) or \
            start < 0 or end <= start or end - start > 512:
        raise ValueError("audition requires an increasing nonnegative range of at most 512 beats")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 64 or \
            any(not isinstance(key, str) or not re.fullmatch(r"track-(0|[1-9][0-9]*)", key) for key in ids) or \
            len(set(ids)) != len(ids):
        raise ValueError("audition requires 1-64 unique ordinary track IDs")
    for key in ids:
        _, track = _track(song, key)
        if bool(getattr(track, "is_foldable", False)):
            raise ValueError("Group tracks would return descendants; select ordinary tracks explicitly")
        if not hasattr(track, "back_to_arranger"):
            raise ValueError("Single Track Back to Arrangement is unavailable")
    return {"startBeats": start, "endBeats": end, "trackIds": list(ids)}


def _observe(song, request, version):
    global _document
    if _document[0] != song:
        _document = (song, str(uuid.uuid4()))
    if len(song.tracks) > 256:
        raise ValueError("audition supports at most 256 Set tracks")
    tracks, slot_count, clip_count = [], 0, 0
    for index, track in enumerate(song.tracks):
        row = _track_record(song, track, index)
        group = row["isGroup"]
        row.update(arrangementOverride=bool(track.back_to_arranger) if hasattr(track, "back_to_arranger") else None,
                   playingSlotIndex=None if group else int(track.playing_slot_index),
                   firedSlotIndex=None if group else int(track.fired_slot_index))
        slots = list(getattr(track, "clip_slots", ()))
        slot_count += len(slots)
        if slot_count > 16384:
            raise ValueError("audition supports at most 16384 Session slots")
        row["recordingClipSlots"], row["triggeredClipSlots"] = [], []
        for slot_index, slot in enumerate(slots):
            clip = slot.clip if slot.has_clip else None
            if clip is not None and bool(getattr(clip, "is_recording", False)):
                row["recordingClipSlots"].append(slot_index)
            if bool(getattr(slot, "is_triggered", False)) or clip is not None and bool(getattr(clip, "is_triggered", False)):
                row["triggeredClipSlots"].append(slot_index)
        active = row["playingSlotIndex"]
        row["playingClip"] = {"id": f"track-{index}:clip-{active}", "name": slots[active].clip.name} \
            if active is not None and 0 <= active < len(slots) and slots[active].has_clip else None
        if row["id"] in request["trackIds"]:
            arranged = list(getattr(track, "arrangement_clips", ()))
            clip_count += len(arranged)
            if clip_count > 4096:
                raise ValueError("audition supports at most 4096 requested Arrangement clips")
            row["overlappingClips"] = [_arrangement_clip_record(clip, row["id"], position)
                                       for position, clip in enumerate(arranged)
                                       if clip.start_time < request["endBeats"] and clip.end_time > request["startBeats"]]
        tracks.append(row)
    return {"stateVersion": version, "documentId": _document[1], "setFingerprint": _set_fingerprint(song),
            "request": request, "transport": _transport_recording_context(song, version),
            "loop": {"enabled": bool(song.loop), "startBeats": float(song.loop_start), "lengthBeats": float(song.loop_length)},
            "tracks": tracks}


def source(song, params, version):
    request = _request(song, params)
    observed = _observe(song, request, version)
    if observed["transport"]["isPlaying"]:
        raise ValueError("stop authorized playback before planning Arrangement audition")
    if observed["transport"]["arrangement"]["record"] or observed["transport"]["session"]["record"] or \
            any(row["recordingClipSlots"] for row in observed["tracks"]):
        raise ValueError("resolve recording before Arrangement audition")
    if any(row["triggeredClipSlots"] or row["firedSlotIndex"] not in (None, -1) for row in observed["tracks"]):
        raise ValueError("resolve pending clip launches before Arrangement audition")
    return observed


def begin(song, params, version):
    before = source(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("Arrangement audition context changed; re-observe before playback")
    request = before["request"]
    original_tracks = tuple(song.tracks)
    error, phase = None, "loop"
    try:
        song.loop_start = request["startBeats"]
        song.loop_length = request["endBeats"] - request["startBeats"]
        song.loop = True
        phase = "position"
        song.current_song_time = request["startBeats"]
        phase = "return-tracks"
        for key in request["trackIds"]:
            _, track = _track(song, key)
            track.back_to_arranger = False
        phase = "playback"
        song.start_playing()
    except Exception as failure:
        # Session playback phase cannot be reconstructed by toggling a flag.
        # Stop dispatching further actions and expose the actual partial state.
        error = str(failure)[:600]
    return {"song": song, "before": before, "request": request, "originalTracks": original_tracks,
            "error": error, "phase": phase}


def complete(song, operation, version):
    error, phase, request = operation["error"], operation["phase"], operation["request"]
    before, original_tracks = operation["before"], operation["originalTracks"]
    if song != operation["song"]:
        return {"stateVersion": version, "started": False, "partial": True, "phase": phase,
                "error": error, "observed": None, "observationError": "document changed during audition"}
    try:
        observed = _observe(song, request, version)
    except Exception as failure:
        return {"stateVersion": version, "started": False, "partial": True,
                "phase": phase, "error": error, "observed": None, "observationError": str(failure)[:600]}
    loop_matches = observed["loop"] == {"enabled": True, "startBeats": request["startBeats"],
                                        "lengthBeats": request["endBeats"] - request["startBeats"]}
    returned = all(row["arrangementOverride"] is False and row["playingSlotIndex"] < 0
                   for row in observed["tracks"] if row["id"] in request["trackIds"])
    topology_stable = tuple(song.tracks) == original_tracks
    unrelated = topology_stable and all(old["arrangementOverride"] == new["arrangementOverride"]
                    for old, new in zip(before["tracks"], observed["tracks"])
                    if old["id"] not in request["trackIds"] and not old["isGroup"])
    transport = observed["transport"]
    recording_off = not transport["arrangement"]["record"] and not transport["session"]["record"] and \
        not any(row["recordingClipSlots"] for row in observed["tracks"])
    position_in_window = request["startBeats"] <= transport["currentSongTime"] < request["endBeats"]
    verified = bool(not error and transport["isPlaying"] and loop_matches and returned and unrelated and recording_off and position_in_window)
    return {"stateVersion": version, "started": verified, "partial": not verified, "phase": phase,
            "error": error, "observed": observed,
            "verification": {"loopMatches": loop_matches, "tracksReturned": returned,
                             "topologyStable": topology_stable,
                             "unrelatedOverridesPreserved": unrelated, "recordingOff": recording_off,
                             "positionInWindow": position_in_window},
            "limitation": "Playback loops until stopped. Readback does not prove audible output. A partial result may have changed controls or returned tracks; inspect before retrying. Earlier Session phase is not restored."}


def start(song, params, version):
    return complete(song, begin(song, params, version), version + 1)
