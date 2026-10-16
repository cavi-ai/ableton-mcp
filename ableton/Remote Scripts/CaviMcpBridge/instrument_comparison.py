"""Guarded native track copies and runtime object-bound mute comparisons."""
import json
import uuid

try:
    from .bridge import (_track, _track_record, _track_state_snapshot, _clip_reference,
                         _clip_timing, _midi_note_record, _set_fingerprint, _undo_step)
except ImportError:
    from bridge import (_track, _track_record, _track_state_snapshot, _clip_reference,
                        _clip_timing, _midi_note_record, _set_fingerprint, _undo_step)

_comparisons = {}


def _recording(song):
    return bool(song.record_mode) or bool(song.session_record)


def _clip_content(song, track_id, clip_id, version):
    clip, timeline = _clip_reference(song, track_id, clip_id)
    if bool(getattr(clip, "is_audio_clip", False)):
        raise ValueError("instrument comparison requires MIDI material")
    if bool(getattr(clip, "is_recording", False)) or bool(getattr(clip, "is_triggered", False)):
        raise ValueError("stop recording and pending clip launches before copying")
    notes = list(clip.get_all_notes_extended())
    if len(notes) > 4096:
        raise ValueError("instrument comparison supports at most 4096 notes per clip")
    timing = _clip_timing(song, track_id, clip_id, version)
    for key in ("stateVersion", "trackId", "clipId", "timeline"):
        timing.pop(key, None)
    return {"name": clip.name, "lengthBeats": float(clip.length), "timing": timing,
            "startMarker": float(getattr(clip, "start_marker", clip.loop_start)),
            "endMarker": float(getattr(clip, "end_marker", clip.loop_end)),
            "color": getattr(clip, "color", None),
            "timeline": None if timeline is None else {key: timeline[key] for key in ("startBeats", "endBeats")},
            "notes": sorted([_midi_note_record(note) for note in notes], key=lambda note: note["noteId"])}


def _content(song, track_id, version):
    _, track = _track(song, track_id)
    state = _track_state_snapshot(song, track_id, version)
    state.pop("stateVersion")
    # Available routing choices grow when a track is inserted. Bind the selected
    # routes rather than treating those new choices as a source-content edit.
    for side in ("input", "output"):
        state["routing"][side] = {key: state["routing"][side][key] for key in ("type", "channel")}
    session = []
    arrangement = list(getattr(track, "arrangement_clips", ()))
    if len(track.clip_slots) + len(arrangement) > 128:
        raise ValueError("instrument comparison supports at most 128 clip slots and Arrangement clips")
    for index, slot in enumerate(track.clip_slots):
        if bool(getattr(slot, "is_triggered", False)):
            raise ValueError("stop pending clip launches before copying")
        session.append(_clip_content(song, track_id, f"{track_id}:clip-{index}", version) if slot.has_clip else None)
    arranged = [_clip_content(song, track_id, f"{track_id}:arrangement-clip-{index}", version)
                for index in range(len(arrangement))]
    if sum(len(clip["notes"]) for clip in session + arranged if clip) > 16384:
        raise ValueError("instrument comparison supports at most 16384 stored notes per track")
    return {"trackState": state, "sessionClips": session, "arrangementClips": arranged}


def _comparable(content):
    def clean(value):
        if isinstance(value, list):
            return [clean(item) for item in value]
        if not isinstance(value, dict):
            return value
        structural = {"trackId", "deviceId", "parameterId", "noteId"}
        if "className" in value or "isGroup" in value:
            structural.add("id")
        result = {key: clean(item) for key, item in value.items() if key not in structural}
        if "notes" in result:
            result["notes"].sort(key=lambda note: json.dumps(note, sort_keys=True))
        return result
    result = clean(content)
    track = result["trackState"]
    for key in ("name", "mute", "solo", "armed"):
        track["track"].pop(key, None)
    for key in ("mute", "solo"):
        track["mixer"].pop(key, None)
    track["routing"].pop("monitoring", None)
    return result


def read_source(song, params, version):
    if bool(song.is_playing):
        raise ValueError("stop transport before preparing an instrument comparison")
    if _recording(song):
        raise ValueError("stop recording before preparing an instrument comparison")
    index, track = _track(song, params["trackId"])
    if not bool(getattr(track, "has_midi_input", False)) or bool(getattr(track, "is_foldable", False)):
        raise ValueError("instrument comparison requires an ordinary MIDI track")
    if bool(getattr(track, "is_frozen", False)):
        raise ValueError("instrument comparison source is frozen")
    if track.arm or track.solo or int(track.current_monitoring_state) == 0:
        raise ValueError("source is armed, soloed or input monitored; resolve before preparing a comparison")
    part, _ = _clip_reference(song, params["trackId"], params["clipId"])
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song),
            "trackId": params["trackId"], "clipId": params["clipId"],
            "sourceName": track.name, "partName": part.name,
            "deviceNames": [device.name for device in track.devices],
            "source": _content(song, params["trackId"], version),
            "tracks": [_track_record(song, candidate, i) for i, candidate in enumerate(song.tracks)],
            "destinationId": f"track-{index + 1}"}


def _prune(song):
    for key, record in list(_comparisons.items()):
        if record["song"] != song or any(record[side] not in song.tracks for side in ("original", "variation")):
            del _comparisons[key]


def read_comparison(song, params, version):
    _prune(song)
    if "comparisonId" not in params:
        return {"stateVersion": version, "comparisons": [read_comparison(song, {"comparisonId": key}, version)
                                                        for key in list(_comparisons)]}
    comparison_id = params.get("comparisonId")
    record = _comparisons.get(comparison_id)
    if record is None:
        raise ValueError("instrument comparison is unavailable in this document or bridge instance; inspect existing tracks")
    errors, result = [], {"stateVersion": version, "setFingerprint": _set_fingerprint(song),
                          "comparisonId": comparison_id, "originalMute": record["originalMute"],
                          "restorationBasis": record.get("restorationBasis", "preparation"),
                          "restoreMutes": record.get("restoreMutes", {"original": record["originalMute"], "variation": True})}
    if _recording(song):
        errors.append("stop recording before switching the comparison")
    if any(bool(getattr(track, "solo", False)) for track in list(song.tracks) + list(song.return_tracks)):
        errors.append("resolve solo conflicts before switching the comparison")
    for side in ("original", "variation"):
        track = record[side]
        index = next(i for i, candidate in enumerate(song.tracks) if candidate == track)
        result[side] = {"trackId": f"track-{index}", "name": track.name, "mute": bool(track.mute),
                        "armed": bool(track.arm), "monitoring": int(track.current_monitoring_state),
                        "isFrozen": bool(getattr(track, "is_frozen", False))}
        clip = record[f"{side}Clip"]
        clip_id, location = None, None
        for slot_index, slot in enumerate(track.clip_slots):
            if slot.has_clip and slot.clip == clip:
                clip_id, location = f"track-{index}:clip-{slot_index}", "session"
                break
        if clip_id is None:
            for clip_index, candidate in enumerate(getattr(track, "arrangement_clips", ())):
                if candidate == clip:
                    clip_id, location = f"track-{index}:arrangement-clip-{clip_index}", "arrangement"
                    break
        result[side].update(clipId=clip_id, location=location)
        if result[side]["isFrozen"]:
            errors.append(f"{side} track is frozen")
        if track.arm or int(track.current_monitoring_state) == 0:
            errors.append(f"{side} track is armed or has live-input monitoring; resolve before switching")
    result["readinessErrors"] = errors
    result["isPlaying"] = bool(song.is_playing)
    return result


def read_adoption_source(song, params, version):
    """Observe an explicitly chosen existing pair; never infer its history."""
    _prune(song)
    if len(_comparisons) >= 16:
        raise ValueError("at most 16 active instrument comparisons are supported")
    if _recording(song):
        raise ValueError("stop recording before adopting an instrument comparison")
    if any(bool(track.solo) for track in list(song.tracks) + list(song.return_tracks)):
        raise ValueError("resolve solo conflicts before adopting an instrument comparison")
    parts, owners = {}, []
    for side in ("original", "variation"):
        reference = params.get(side)
        if not isinstance(reference, dict):
            raise ValueError("adoption requires exact original and variation track/clip references")
        track_id, clip_id = reference.get("trackId"), reference.get("clipId")
        _, track = _track(song, track_id)
        if not bool(getattr(track, "has_midi_input", False)) or bool(getattr(track, "is_foldable", False)):
            raise ValueError("adoption requires two ordinary MIDI tracks")
        if track in owners:
            raise ValueError("adoption requires two different tracks")
        if any(track in (record["original"], record["variation"]) for record in _comparisons.values()):
            raise ValueError("track already belongs to an active comparison; inspect that handle")
        if bool(getattr(track, "is_frozen", False)) or track.arm or int(track.current_monitoring_state) == 0:
            raise ValueError("adoption refuses frozen, armed or input-monitored tracks")
        owners.append(track)
        parts[side] = {"trackId": track_id, "clipId": clip_id,
                       "trackState": _track_state_snapshot(song, track_id, version),
                       "clip": _clip_content(song, track_id, clip_id, version)}
    mutes = {side: bool(track.mute) for side, track in zip(("original", "variation"), owners)}
    if not any(mutes.values()):
        raise ValueError("both tracks are unmuted; resolve the intended comparison mute state first")
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "isPlaying": bool(song.is_playing),
            **parts, "restoreMutes": mutes,
            "tracks": [_track_record(song, track, index) for index, track in enumerate(song.tracks)]}


def adopt(song, params, version):
    if params.get("expectedStateVersion") != version:
        raise ValueError("instrument comparison state version changed")
    before = read_adoption_source(song, params, version)
    if before != params.get("before"):
        raise ValueError("instrument comparison adoption content or topology changed")
    record = {"song": song, "originalMute": before["restoreMutes"]["original"],
              "restoreMutes": dict(before["restoreMutes"]), "restorationBasis": "adoption"}
    for side in ("original", "variation"):
        reference = params[side]
        record[side] = _track(song, reference["trackId"])[1]
        record[f"{side}Clip"] = _clip_reference(song, reference["trackId"], reference["clipId"])[0]
    comparison_id = str(uuid.uuid4())
    _comparisons[comparison_id] = record
    return {**read_comparison(song, {"comparisonId": comparison_id}, version + 1),
            "createdTracks": False, "contentChanged": False, "playbackChanged": False,
            "limitation": "New handle for the explicitly chosen parts. Restore uses adoption-time mutes; no earlier identity or copy history is established."}


def begin_prepare(song, params, version):
    if params.get("expectedStateVersion") != version:
        raise ValueError("instrument comparison state version changed")
    before = read_source(song, params, version)
    if before != params.get("before"):
        raise ValueError("instrument comparison source or topology changed")
    name = params.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 128:
        raise ValueError("comparison name must contain 1-128 characters")
    _prune(song)
    if len(_comparisons) >= 16:
        raise ValueError("at most 16 active instrument comparisons are supported; inspect existing comparisons")
    index, source = _track(song, params["trackId"])
    if any(source in (record["original"], record["variation"]) for record in _comparisons.values()):
        raise ValueError("track already belongs to an active comparison; restore and finish it first")
    old_tracks, original_mute = list(song.tracks), bool(source.mute)
    created = None
    with _undo_step(song):
        try:
            # Native duplication inherits mute: silence the clone from creation,
            # then restore the source's exact pre-comparison mute state.
            source.mute = True
            try:
                song.duplicate_track(index)
            finally:
                added = [track for track in song.tracks if track not in old_tracks]
                if len(added) == 1:
                    created = added[0]
                source.mute = original_mute
            if created is None or song.tracks[index + 1] != created or len(song.tracks) != len(old_tracks) + 1:
                raise RuntimeError("native instrument copy topology readback mismatch")
            created.name, created.mute, created.solo, created.arm = name, True, False, False
            created.current_monitoring_state = 2
            if created.name != name or not created.mute or created.solo or created.arm or int(created.current_monitoring_state) != 2:
                raise RuntimeError("native instrument copy safety controls readback mismatch")
        except Exception as error:
            cleanup = []
            try:
                source.mute = original_mute
                if bool(source.mute) != original_mute:
                    raise RuntimeError("original mute was not restored")
            except Exception as restore_error:
                cleanup.append(str(restore_error))
            if created is not None:
                try:
                    actual = next(i for i, track in enumerate(song.tracks) if track == created)
                    song.delete_track(actual)
                    if created in song.tracks:
                        raise RuntimeError("new comparison track remains")
                except Exception as delete_error:
                    cleanup.append(str(delete_error))
            if cleanup:
                raise RuntimeError(f"instrument copy failed: {error}; cleanup incomplete: {'; '.join(cleanup)}") from error
            raise
    return {"song": song, "params": params, "before": before, "index": index, "source": source,
            "created": created, "oldTracks": old_tracks, "originalMute": original_mute}


def abort_prepare(operation, error):
    song, created = operation["song"], operation["created"]
    try:
        if created in song.tracks:
            with _undo_step(song):
                song.delete_track(next(i for i, track in enumerate(song.tracks) if track == created))
            if created in song.tracks:
                raise RuntimeError("new comparison track remains")
    except Exception as cleanup_error:
        raise RuntimeError(f"instrument copy failed: {error}; cleanup incomplete: {cleanup_error}") from error
    raise error


def complete_prepare(song, operation, version):
    params, before, index = operation["params"], operation["before"], operation["index"]
    source, created, original_mute = operation["source"], operation["created"], operation["originalMute"]
    try:
        expected_tracks = list(operation["oldTracks"])
        expected_tracks.insert(index + 1, created)
        if song != operation["song"] or list(song.tracks) != expected_tracks:
            raise RuntimeError("instrument comparison document or track topology changed while copying")
        if bool(song.is_playing) or _recording(song):
            raise RuntimeError("transport or recording started while copying")
        if created.name != params["name"] or not created.mute or created.solo or created.arm or int(created.current_monitoring_state) != 2:
            raise RuntimeError("native instrument copy safety controls readback mismatch")
        if _comparable(_content(song, f"track-{index + 1}", version)) != _comparable(before["source"]):
            raise RuntimeError("native instrument copy content readback mismatch")
        if _content(song, params["trackId"], version) != before["source"]:
            raise RuntimeError("original instrument track changed while copying")
    except Exception as error:
        abort_prepare(operation, error)
    comparison_id = str(uuid.uuid4())
    source_clip, _ = _clip_reference(song, params["trackId"], params["clipId"])
    copy_id = f"track-{index + 1}" + params["clipId"][len(params["trackId"]):]
    copy_clip, _ = _clip_reference(song, f"track-{index + 1}", copy_id)
    _comparisons[comparison_id] = {"song": song, "original": source, "variation": created,
                                    "originalMute": original_mute, "originalClip": source_clip, "variationClip": copy_clip}
    return {**read_comparison(song, {"comparisonId": comparison_id}, version),
            "verification": "Exposed devices, routing, notes and clip timing match; opaque plug-in state and audio are not independently verified.",
            "identityWarning": "Track, clip and device IDs after the inserted track have shifted; re-read before further edits."}


def prepare(song, params, version):
    return complete_prepare(song, begin_prepare(song, params, version), version + 1)


def select(song, params, version):
    if params.get("expectedStateVersion") != version:
        raise ValueError("instrument comparison state version changed")
    before = read_comparison(song, params, version)
    if before != params.get("before"):
        raise ValueError("instrument comparison pair or playback state changed")
    if before["readinessErrors"]:
        raise ValueError("; ".join(before["readinessErrors"]))
    choice = params.get("choice")
    if choice not in ("original", "variation", "restore"):
        raise ValueError("comparison choice must be original, variation or restore")
    if type(params.get("finish", False)) is not bool:
        raise ValueError("comparison finish must be boolean")
    record = _comparisons[params["comparisonId"]]
    wanted = dict(before["restoreMutes"]) if choice == "restore" else {
        "original": choice != "original", "variation": choice != "variation"}
    with _undo_step(song):
        try:
            # Mute first so a switch never deliberately enables both tracks.
            for side in ("original", "variation"):
                if wanted[side]:
                    record[side].mute = True
            for side in ("original", "variation"):
                record[side].mute = wanted[side]
            if any(bool(record[side].mute) != wanted[side] for side in wanted):
                raise RuntimeError("instrument comparison mute readback mismatch")
        except Exception as error:
            cleanup = []
            for side in ("original", "variation"):
                try:
                    record[side].mute = True
                    if not record[side].mute:
                        raise RuntimeError(f"{side} could not be muted before rollback")
                except Exception as restore_error:
                    cleanup.append(str(restore_error))
            if not cleanup:
                for side in ("original", "variation"):
                    if before[side]["mute"]:
                        continue
                    try:
                        record[side].mute = False
                        if record[side].mute:
                            raise RuntimeError(f"{side} mute was not restored")
                    except Exception as restore_error:
                        cleanup.append(str(restore_error))
                        break
            if cleanup:
                raise RuntimeError(f"comparison switch failed: {error}; rollback incomplete: {'; '.join(cleanup)}") from error
            raise
    result = {**read_comparison(song, params, version + 1), "selected": choice,
              "comparisonActive": not params.get("finish", False), "playbackChanged": False,
              "limitation": "Mute selection only; it does not launch clips or prove audible output."}
    if params.get("finish", False):
        del _comparisons[params["comparisonId"]]
    return result
