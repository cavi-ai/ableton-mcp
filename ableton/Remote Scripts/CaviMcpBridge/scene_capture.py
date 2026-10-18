"""Capture the current Session clip combination without replay or rollback."""
import re
import uuid
import copy
try:
    from .bridge import _scene_record, _set_fingerprint, _undo_step
    from .clip_duplication import _content, _comparable
except ImportError:
    from bridge import _scene_record, _set_fingerprint, _undo_step
    from clip_duplication import _content, _comparable

_identity = None
_token = None


def _safe(song):
    if not song.is_playing or song.record_mode or song.session_record or getattr(song, "is_counting_in", False):
        raise ValueError("Session scene capture requires playing transport with recording and count-in off")


def _scene_state(scene):
    record = _scene_record(scene, 0)
    record.pop("id")
    return record


def _settled(song):
    _safe(song)
    if any(getattr(scene, "is_triggered", False) for scene in song.scenes):
        raise ValueError("resolve pending scene launches before capture")
    for track in song.tracks:
        if not getattr(track, "is_foldable", False) and (
                (getattr(track, "can_be_armed", True) and bool(track.arm)) or bool(getattr(track, "implicit_arm", False))):
            raise ValueError("resolve all explicit and implicit track arms before native capture launches its new row")
        if not getattr(track, "is_foldable", False) and int(track.fired_slot_index) != -1:
            raise ValueError("resolve pending clip launches/stops before capture")
        for slot in track.clip_slots:
            if getattr(slot, "is_triggered", False) or slot.has_clip and (
                    getattr(slot.clip, "is_recording", False) or getattr(slot.clip, "is_triggered", False)):
                raise ValueError("resolve recording and pending clip launches/stops before capture")


def _snapshot(song, params, version):
    global _identity, _token
    _safe(song)
    key = params.get("afterSceneId")
    if not isinstance(key, str) or not re.fullmatch(r"scene-(0|[1-9][0-9]*)", key):
        raise ValueError("canonical afterSceneId required")
    index = int(key[6:])
    scenes, tracks = tuple(song.scenes), tuple(song.tracks)
    if len(tracks) > 256 or len(scenes) >= 1024 or sum(len(t.clip_slots) + 1 for t in tracks) > 16384:
        raise ValueError("scene capture requires room within 256 tracks, 1024 scenes and 16384 Session slots")
    if index >= len(scenes) or song.view.selected_scene != scenes[index]:
        raise ValueError("afterSceneId must match the currently selected scene")
    if not callable(getattr(song, "capture_and_insert_scene", None)):
        raise ValueError("native Session scene capture is unavailable")
    _settled(song)
    refs, rows, sources, slots, total_notes = [song, tracks, scenes, scenes[index]], [], [], [], 0
    for i, track in enumerate(tracks):
        layout = tuple((slot, slot.clip if slot.has_clip else None) for slot in track.clip_slots)
        if len(layout) != len(scenes):
            raise ValueError("Session scene/slot topology is inconsistent")
        slots.append(layout)
        refs.extend(layout)
        group = bool(getattr(track, "is_foldable", False))
        active = None if group else int(track.playing_slot_index)
        clip = layout[active][1] if active is not None and 0 <= active < len(layout) else None
        if active is not None and active >= 0 and (clip is None or not getattr(clip, "is_playing", False)):
            raise ValueError("playing Session clip is unavailable")
        if clip is not None and getattr(track, "is_frozen", False):
            raise ValueError("resolve a frozen playing source before capture")
        content = _content(song, f"track-{i}", f"track-{i}:clip-{active}", version) if clip is not None else None
        total_notes += len((content or {}).get("notes", []))
        if total_notes > 16384:
            raise ValueError("scene capture supports at most 16384 playing source notes")
        sources.append((clip, active, content))
        rows.append({"trackId": f"track-{i}", "name": track.name, "isGroup": group,
                     "mute": bool(track.mute), "solo": bool(track.solo),
                     "armed": bool(track.arm) if getattr(track, "can_be_armed", not group) else False,
                     "arrangementOverride": bool(track.back_to_arranger) if hasattr(track, "back_to_arranger") else None,
                     "playingSlotIndex": active, "playingClipId": f"track-{i}:clip-{active}" if clip is not None else None,
                     "source": content})
    if not any(clip is not None for clip, _, _ in sources):
        raise ValueError("no playing Session clips to capture")
    refs = tuple(refs)
    if refs != _identity:
        _identity, _token = refs, str(uuid.uuid4())
    states = tuple(_scene_state(scene) for scene in scenes)
    result = {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": _token,
              "afterSceneId": key, "anchor": _scene_record(scenes[index], index),
              "scenes": [dict(state, id=f"scene-{i}") for i, state in enumerate(states)], "tracks": rows,
              "isPlaying": True, "recording": False, "countingIn": False}
    binding = {"tracks": tracks, "scenes": scenes, "slots": slots, "sources": sources, "sceneStates": states, "index": index + 1}
    return result, binding


def context(song, params, version):
    return _snapshot(song, params, version)[0]


def _layout(song, binding, created):
    if created is None or tuple(song.tracks) != binding["tracks"]:
        return False
    index = binding["index"]
    expected = binding["scenes"][:index] + (created,) + binding["scenes"][index:]
    if tuple(song.scenes) != expected:
        return False
    if any(_scene_state(scene) != state for scene, state in zip(binding["scenes"], binding["sceneStates"])):
        return False
    for track, old in zip(binding["tracks"], binding["slots"]):
        current = tuple((slot, slot.clip if slot.has_clip else None) for slot in track.clip_slots)
        if len(current) != len(old) + 1 or current[:index] + current[index + 1:] != old:
            return False
    return True


def _observe_sources(song, binding, version):
    preserved, playback, sources, activity = tuple(song.tracks) == binding["tracks"], bool(song.is_playing), [], []
    for i, (track, source) in enumerate(zip(binding["tracks"], binding["sources"])):
        original, old_index, content = source
        if old_index is None:
            continue
        slots = tuple(track.clip_slots)
        active = int(track.playing_slot_index)
        playing = slots[active].clip if 0 <= active < len(slots) and slots[active].has_clip else None
        activity.append({"trackId": f"track-{i}", "previousPlayingSlotIndex": old_index,
                         "playingSlotIndex": active, "playingClipId": f"track-{i}:clip-{active}" if playing is not None else None,
                         "sourcePlaying": bool(getattr(original, "is_playing", False)) if original is not None else None})
        if original is None:
            playback = playback and active == old_index
            continue
        positions = [n for n, slot in enumerate(slots) if slot.has_clip and slot.clip == original]
        current_id = f"track-{i}:clip-{positions[0]}" if len(positions) == 1 else None
        matches = current_id is not None and _content(song, f"track-{i}", current_id, version) == content
        preserved = preserved and matches
        playback = playback and playing == original and bool(getattr(original, "is_playing", False))
        sources.append({"trackId": f"track-{i}", "previousClipId": f"track-{i}:clip-{old_index}",
                        "currentClipId": current_id, "contentPreserved": matches})
    return preserved, playback, sources, {"isPlaying": bool(song.is_playing), "tracks": activity}


def _material(content):
    result = copy.deepcopy(_comparable(content))
    for state in (result["timing"], result.get("audio", {})):
        for key in ("startBeats", "startSeconds"):
            state.get("markers", {}).pop(key, None)
    return result


def _start_marker(content):
    markers = (content or {}).get("timing", {}).get("markers", {})
    return {key: value for key, value in markers.items() if key in ("supported", "unit", "startBeats", "startSeconds")}


def _observe_row(song, binding, version):
    rows, matches = [], True
    for i, (track, source) in enumerate(zip(binding["tracks"], binding["sources"])):
        slot, original = track.clip_slots[binding["index"]], source[0]
        content = _content(song, f"track-{i}", f"track-{i}:clip-{binding['index']}", version) if slot.has_clip else None
        expected = source[2]
        owned = content is not None and slot.clip != original
        matched = content is None if original is None else owned and _comparable(content) == _comparable(expected)
        material = content is None if original is None else owned and _material(content) == _material(expected)
        starts = {"source": _start_marker(expected), "captured": _start_marker(content)}
        matches = matches and material
        rows.append({"trackId": f"track-{i}", "clipId": f"track-{i}:clip-{binding['index']}",
                     "hasClip": bool(slot.has_clip), "hasStopButton": getattr(slot, "has_stop_button", None),
                     "contentMatched": matched, "materialMatched": material, "startMarkerMatched": starts["source"] == starts["captured"],
                     "startMarkers": starts, "content": content,
                     "isPlaying": bool(getattr(slot.clip, "is_playing", False)) if slot.has_clip else False})
    return matches, rows


def capture(song, params, version):
    name = params.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("explicit name of 1 to 128 characters without controls required")
    before, binding = _snapshot(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or params.get("before") != before:
        raise ValueError("Session scene capture context changed; review a fresh plan")
    attempted, returned, named, created, error = False, False, False, None, None
    try:
        with _undo_step(song):
            if context(song, params, version) != before:
                raise ValueError("Session combination changed before native capture")
            attempted = True
            song.capture_and_insert_scene()
            returned = True
            candidate = song.scenes[binding["index"]] if len(song.scenes) == len(binding["scenes"]) + 1 else None
            if not _layout(song, binding, candidate):
                raise ValueError("new scene ownership or existing layout is unconfirmed")
            created = candidate
            source_ok, _, _, _ = _observe_sources(song, binding, version)
            row_ok, _ = _observe_row(song, binding, version)
            _settled(song)
            if not source_ok or not row_ok or not _layout(song, binding, created):
                raise ValueError("captured row material or source changed; inspect retained work")
            created.name = name
            named = True
    except Exception as failure:
        if not attempted:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {"stateVersion": version + 1, "captureRequested": attempted, "nativeReturned": returned,
              "nameWriteReturned": named, "captureVerified": False, "sceneId": None, "scene": None,
              "sourcePreserved": False, "originalPlaybackRetained": False, "capturedPlaybackVerified": False,
              "existingLayoutPreserved": False, "error": error}
    try:
        source_ok, playing, sources, activity = _observe_sources(song, binding, version + 1)
        result.update(sourcePreserved=source_ok, originalPlaybackRetained=playing, sources=sources, playback=activity)
        layout = _layout(song, binding, created)
        result["existingLayoutPreserved"] = layout
        if not returned or not layout:
            return {**result, "error": error or "new scene ownership is unconfirmed"}
        row_ok, rows = _observe_row(song, binding, version + 1)
        scene = _scene_record(created, binding["index"])
        try:
            _settled(song)
        except ValueError as failure:
            error = error or str(failure)[:600]
            result["error"] = error
        expected = [i for i, source in enumerate(binding["sources"]) if source[0] is not None]
        result["capturedPlaybackVerified"] = bool(expected) and bool(song.is_playing) and all(
            rows[i]["hasClip"] and rows[i]["materialMatched"] and rows[i]["isPlaying"]
            and int(binding["tracks"][i].playing_slot_index) == binding["index"] for i in expected)
        verified = error is None and named and source_ok and row_ok and scene["name"] == name and _layout(song, binding, created)
        return {**result, "sceneId": scene["id"], "scene": scene, "rows": rows, "captureVerified": verified,
                "error": error if verified or error else "Session scene capture readback did not match"}
    except Exception as failure:
        return {**result, "observationError": (str(failure) or failure.__class__.__name__)[:600]}
