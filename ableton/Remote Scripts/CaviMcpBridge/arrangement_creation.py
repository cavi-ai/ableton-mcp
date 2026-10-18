"""Create and initialize one owned MIDI clip directly in Arrangement."""
import math
import re
import uuid
try:
    from .bridge import _track, _arrangement_clip_record, _arrangement_clips, _clip_timing, _midi_note_record, _new_midi_note, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _track, _arrangement_clip_record, _arrangement_clips, _clip_timing, _midi_note_record, _new_midi_note, _set_fingerprint, _undo_step

_song = None
_identities = {}


def _objects(song, params):
    track_id = params.get("trackId")
    if not isinstance(track_id, str) or not re.fullmatch(r"track-(?:0|[1-9][0-9]*)", track_id):
        raise ValueError("canonical ordinary MIDI track ID required")
    if len(song.tracks) > 256:
        raise ValueError("Arrangement creation supports at most 256 tracks")
    _, track = _track(song, track_id)
    if getattr(track, "is_foldable", False) or getattr(track, "has_midi_input", None) is not True:
        raise ValueError("ordinary MIDI track required")
    if len(track.arrangement_clips) > 4096:
        raise ValueError("Arrangement creation supports at most 4096 clips")
    return track, (tuple(song.tracks), track, tuple(track.arrangement_clips))


def target(song, params, version):
    global _song
    track, binding = _objects(song, params)
    if len(track.arrangement_clips) >= 4096:
        raise ValueError("destination must have room within 4096 clips")
    if getattr(track, "is_frozen", False) or not callable(getattr(track, "create_midi_clip", None)):
        raise ValueError("native MIDI creation unavailable on this track")
    if song.record_mode or song.session_record or getattr(song, "is_counting_in", False):
        raise ValueError("resolve recording and count-in before creation")
    start, length = params.get("startBeats"), params.get("lengthBeats")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (start, length)):
        raise ValueError("finite startBeats and lengthBeats required")
    if start < 0 or length <= 0 or start + length > 1576800 or start + length <= start:
        raise ValueError("positive interval within 0 to 1576800 beats required")
    if any(start < clip.end_time and start + length > clip.start_time for clip in track.arrangement_clips):
        raise ValueError("creation would overlap an existing Arrangement clip")
    if _song != song:
        _song = song
        _identities.clear()
    key = params["trackId"]
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if key not in _identities and len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    result = {"stateVersion": version, "setFingerprint": _set_fingerprint(song), "identityToken": cached[1],
              "trackId": key, "trackName": track.name, "startBeats": start, "lengthBeats": length,
              "endBeats": start + length, "clips": _arrangement_clips(song, key, version)["clips"]}
    if _objects(song, params)[1] != binding:
        raise ValueError("native destination changed during inspection")
    return result


def _notes(params):
    notes, length = params.get("notes"), params.get("lengthBeats")
    if not isinstance(notes, list) or len(notes) > 4096:
        raise ValueError("notes must contain at most 4096 events")
    normalized = []
    for note in notes:
        if not isinstance(note, dict) or set(note) - {"pitch", "start", "duration", "velocity", "mute"}:
            raise ValueError("basic MIDI note fields required")
        pitch, velocity = note.get("pitch"), note.get("velocity")
        start, duration = note.get("start"), note.get("duration")
        if type(pitch) is not int or not 0 <= pitch <= 127 or type(velocity) is not int or not 1 <= velocity <= 127:
            raise ValueError("invalid MIDI pitch or velocity")
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (start, duration)):
            raise ValueError("finite note timing required")
        if start < 0 or duration <= 0 or not isinstance(length, (int, float)) or start + duration > length:
            raise ValueError("notes must fit within the requested clip")
        if type(note.get("mute", False)) is not bool:
            raise ValueError("note mute must be boolean")
        normalized.append({"pitch": pitch, "velocity": velocity, "start": start, "duration": duration,
                           "mute": note.get("mute", False), "velocityDeviation": 0, "releaseVelocity": 0, "probability": 1.0})
    return normalized


def _owned(song, params, binding, before, created):
    track, current = _objects(song, params)
    owners = current[0] == binding[0] and track == binding[1]
    layout = owners and created is not None and not any(created == old for old in binding[2]) and sum(item == created for item in track.arrangement_clips) == 1 and tuple(item for item in track.arrangement_clips if item != created) == binding[2]
    if layout:
        layout = [_arrangement_clip_record(item, params["trackId"], i) for i, item in enumerate(binding[2])] == before["clips"]
    return track, owners, layout


def _same_notes(actual, expected):
    key = lambda note: (note["pitch"], note["start"], note["duration"], note["velocity"], note["mute"])
    return len(actual) == len(expected) and all(all(
        math.isclose(left[field], right[field], rel_tol=0, abs_tol=1e-6) if field in ("start", "duration") else left[field] == right[field]
        for field in right) for left, right in zip(sorted(actual, key=key), sorted(expected, key=key)))


def _ready(song, params, binding, before, created):
    track, _, retained = _owned(song, params, binding, before, created)
    if not retained or getattr(track, "is_frozen", False) or song.record_mode or song.session_record or getattr(song, "is_counting_in", False):
        raise RuntimeError("new clip ownership or creation safety changed")
    if getattr(created, "is_audio_clip", None) is not False or list(created.get_all_notes_extended()):
        raise RuntimeError("new empty MIDI clip ownership is unconfirmed")
    if not math.isclose(created.start_time, before["startBeats"], rel_tol=0, abs_tol=1e-8) or not math.isclose(created.end_time, before["endBeats"], rel_tol=0, abs_tol=1e-8):
        raise RuntimeError("native clip interval did not match")


def create(song, params, version):
    name = params.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("name requires 1 to 128 characters without controls")
    notes = _notes(params)
    before = target(song, params, version)
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before"):
        raise ValueError("Arrangement destination changed; review a fresh plan")
    track, binding = _objects(song, params)
    attempted, returned, named, notes_requested, notes_returned, created, error = False, False, False, False, False, None, None
    try:
        with _undo_step(song):
            if target(song, params, version) != before or _objects(song, params)[1] != binding:
                raise ValueError("Arrangement destination changed before creation")
            attempted = True
            native_result = track.create_midi_clip(before["startBeats"], before["lengthBeats"])
            returned = True
            candidates = [item for item in track.arrangement_clips if not any(item == old for old in binding[2])]
            if len(candidates) != 1 or native_result is not None and native_result != candidates[0]:
                raise RuntimeError("new native clip ownership is unconfirmed")
            created = candidates[0]
            _ready(song, params, binding, before, created)
            created.name = name
            named = True
            if notes:
                _ready(song, params, binding, before, created)
                notes_requested = True
                created.add_new_notes(tuple(_new_midi_note(note) for note in notes))
                notes_returned = True
    except Exception as failure:
        if not attempted:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {"stateVersion": version + 1, "creationRequested": attempted, "nativeReturned": returned,
              "nameWriteReturned": named, "notesWriteRequested": notes_requested, "notesWriteReturned": notes_returned,
              "verified": False, "ownerRetained": False, "existingLayoutPreserved": False,
              "createdClipId": None, "observedClip": None, "observedNotes": None, "error": error}
    try:
        track, owners, retained = _owned(song, params, binding, before, created)
        result.update(ownerRetained=owners, existingLayoutPreserved=retained,
                      clips=_arrangement_clips(song, params["trackId"], version + 1)["clips"])
        if not returned or not retained:
            return {**result, "error": error or "new clip identity or existing layout is unconfirmed"}
        index = next(i for i, item in enumerate(track.arrangement_clips) if item == created)
        clip_id = f'{params["trackId"]}:arrangement-clip-{index}'
        observed = _arrangement_clip_record(created, params["trackId"], index)
        actual = [_midi_note_record(note) for note in created.get_all_notes_extended()]
        timing = _clip_timing(song, params["trackId"], clip_id, version + 1)
        interval = math.isclose(observed["startBeats"], before["startBeats"], rel_tol=0, abs_tol=1e-8) and math.isclose(observed["endBeats"], before["endBeats"], rel_tol=0, abs_tol=1e-8)
        verified = error is None and named and (not notes or notes_returned) and interval and observed["name"] == name and _same_notes(actual, notes) and _owned(song, params, binding, before, created)[2]
        return {**result, "verified": verified, "createdClipId": clip_id, "observedClip": observed,
                "observedNotes": actual, "observedTiming": timing, "error": error if verified or error else "new clip readback did not match"}
    except Exception as failure:
        return {**result, "observationError": (str(failure) or failure.__class__.__name__)[:600]}
