"""Guarded interactive overdub of one already playing Session MIDI loop."""
import hashlib
import json
import uuid

try:
    from .bridge import (_clip_slot, _clip_timing, _midi_note_record, _set_fingerprint,
                         _track_routing, _track_midi_routing, _undo_step)
except ImportError:
    from bridge import (_clip_slot, _clip_timing, _midi_note_record, _set_fingerprint,
                        _track_routing, _track_midi_routing, _undo_step)

_identities = {}
_song = None


def context(song, params, version, include_baseline=True, allow_target_recording=False):
    global _song
    track, index, slot = _clip_slot(song, params.get("trackId"), params.get("clipId"))
    if not slot.has_clip or not bool(getattr(slot.clip, "is_midi_clip", False)):
        raise ValueError("Session overdub requires an existing MIDI clip")
    clip = slot.clip
    if not song.is_playing or bool(song.is_counting_in) or song.record_mode:
        raise ValueError("Session overdub requires playing transport with Arrangement recording and count-in off")
    if song.session_automation_record:
        raise ValueError("resolve automation recording arm before Session MIDI overdub")
    if not track.can_be_armed or not track.arm or track.is_frozen:
        raise ValueError("Session overdub requires an armed, unfrozen MIDI track")
    if int(track.playing_slot_index) != index or not clip.is_playing or not clip.looping:
        raise ValueError("Session overdub requires the exact target loop already playing")
    if len(song.tracks) > 256 or sum(len(t.clip_slots) for t in song.tracks) > 16384:
        raise ValueError("Session overdub supports at most 256 tracks and 16384 slots")
    if any(bool(getattr(scene, "is_triggered", False)) for scene in song.scenes):
        raise ValueError("resolve pending scene launches before Session overdub")
    tracks = []
    for i, candidate in enumerate(song.tracks):
        group = bool(getattr(candidate, "is_foldable", False))
        armed = bool(candidate.arm) if not group and candidate.can_be_armed else False
        implicit = bool(getattr(candidate, "implicit_arm", False)) if not group else False
        if candidate != track and (armed or implicit):
            raise ValueError("resolve other explicit and implicit track arms before Session overdub")
        fired = int(candidate.fired_slot_index)
        if not group and fired != -1:
            raise ValueError("resolve pending launches/stops before Session overdub")
        for item in candidate.clip_slots:
            if bool(getattr(item, "is_triggered", False)) or item.has_clip and bool(item.clip.is_triggered):
                raise ValueError("resolve pending launches before Session overdub")
            if item.has_clip and (bool(item.clip.is_recording) or bool(item.clip.is_overdubbing)) and (
                    item.clip != clip or not song.session_record and not allow_target_recording):
                raise ValueError("resolve other clip recording before Session overdub")
        tracks.append({"trackId": f"track-{i}", "name": candidate.name, "armed": armed,
                       "implicitArm": implicit, "playingSlotIndex": int(candidate.playing_slot_index),
                       "firedSlotIndex": fired})
    if _song != song:
        _song = song
        _identities.clear()
    key = (params["trackId"], params["clipId"])
    refs = (tuple(song.tracks), tuple(song.scenes), track, slot, clip)
    cached = _identities.get(key)
    if cached is None or cached[0] != refs:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (refs, str(uuid.uuid4()))
        _identities[key] = cached
    # Bind existing source notes before starting. While recording, incoming notes
    # and the advancing playhead must not prevent a confirmed stop.
    baseline = None
    if not song.session_record and include_baseline:
        notes = list(clip.get_all_notes_extended())
        if len(notes) > 16384:
            raise ValueError("Session overdub supports at most 16384 baseline notes")
        digest = hashlib.sha256(json.dumps([_midi_note_record(n) for n in notes], sort_keys=True).encode()).hexdigest()
        baseline = {"noteCount": len(notes), "notesSha256": digest}
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
            "trackId": params["trackId"], "clipId": params["clipId"], "clipName": clip.name,
            "sessionRecord": bool(song.session_record), "isRecording": bool(clip.is_recording),
            "isOverdubbing": bool(clip.is_overdubbing), "isPlaying": True, "baseline": baseline,
            "timing": _clip_timing(song, params["trackId"], params["clipId"], version), "tracks": tracks,
            "routing": _track_routing(song, params["trackId"], version),
            "midiRouting": _track_midi_routing(song, params["trackId"], version),
            "musical": {"tempo": float(song.tempo), "numerator": int(song.signature_numerator),
                        "denominator": int(song.signature_denominator),
                        "midiRecordingQuantization": int(song.midi_recording_quantization)},
            "arrangementOverdub": bool(song.arrangement_overdub), "legacyOverdub": bool(song.overdub)}


def change(song, params, version):
    enabled = params.get("enabled")
    if type(enabled) is not bool:
        raise ValueError("enabled must be boolean")
    before = context(song, params, version)
    if params.get("expectedStateVersion") != version or params.get("before") != before:
        raise ValueError("Session overdub context changed; inspect before retrying")
    if before["sessionRecord"] == enabled:
        raise ValueError("Session recording already matches the request; inspect instead of replaying")
    track, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
    clip = slot.clip
    attempted, native_returned, error = False, False, None
    try:
        with _undo_step(song):
            if context(song, params, version) != before:
                raise ValueError("Session overdub context changed at undo entry")
            # Native Session Overdub uses session_record. Do not touch the
            # Arrangement/legacy overdub switch, transport, arms or routing.
            attempted = True
            song.session_record = enabled
            native_returned = True
    except Exception as caught:
        if not attempted:
            raise
        error = str(caught) or caught.__class__.__name__
    observed, observation_error = None, None
    try:
        current_track, _, current_slot = _clip_slot(song, params["trackId"], params["clipId"])
        if current_track != track or current_slot != slot or not slot.has_clip or slot.clip != clip:
            raise ValueError("Session overdub target changed during native request")
        observed = {"sessionRecord": bool(song.session_record), "isPlaying": bool(song.is_playing),
                    "clipIsPlaying": bool(clip.is_playing), "isRecording": bool(clip.is_recording),
                    "isOverdubbing": bool(clip.is_overdubbing)}
    except Exception as caught:
        observation_error = str(caught) or caught.__class__.__name__
    scope_verified, scope_error = False, None
    try:
        after = context(song, params, version, include_baseline=False, allow_target_recording=True)
        # Live's legacy overdub readback follows Session Overdub on supported
        # versions; its expected transition is not an unrelated scope change.
        evolving = {"baseline", "sessionRecord", "isRecording", "isOverdubbing", "legacyOverdub"}
        scope_verified = ({k: v for k, v in after.items() if k not in evolving} ==
                          {k: v for k, v in before.items() if k not in evolving})
        if not scope_verified:
            scope_error = "Session overdub scope changed during native request"
    except Exception as caught:
        scope_error = str(caught) or caught.__class__.__name__
    verified = observed is not None and observed["sessionRecord"] == enabled
    return {"stateVersion": version + 1, "operationRequested": True, "nativeReturned": native_returned,
            "sessionRecordVerified": verified, "performanceVerified": False,
            "overdubActiveObserved": bool(observed and observed["isOverdubbing"]),
            "recordingStoppedObserved": bool(observed and not observed["sessionRecord"] and
                                              not observed["isRecording"] and not observed["isOverdubbing"]),
            "scopeVerified": scope_verified, "scopeError": scope_error,
            "requiresInspection": not verified or not scope_verified or error is not None, "error": error,
            "observationError": observation_error, "observed": observed}
