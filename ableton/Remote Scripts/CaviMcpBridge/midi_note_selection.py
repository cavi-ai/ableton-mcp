"""Read current detail-clip note selection and bind optional property edits."""
import uuid
try:
    from .bridge import _midi_clip, _midi_note_record, _track, _set_fingerprint
except ImportError:
    from bridge import _midi_clip, _midi_note_record, _track, _set_fingerprint

_song = None
_contexts = {}


def _flag(owner, name):
    try: value = getattr(owner, name, None)
    except Exception: return None
    return bool(value) if type(value) in (bool, int) and value in (0, 1) else None


def _notes(getter):
    notes = []
    for note in getter():
        if len(notes) >= 4096: raise ValueError('selected notes exceed 4096; selection was not truncated')
        notes.append(_midi_note_record(note))
    notes.sort(key=lambda note: note['noteId'])
    if len({note['noteId'] for note in notes}) != len(notes): raise ValueError('duplicate selected note IDs')
    return notes


def context(song, params, version):
    global _song
    if _song != song:
        _song = song
        _contexts.clear()
    track_id, clip_id = params['trackId'], params['clipId']
    _, track = _track(song, track_id)
    clip, timeline = _midi_clip(song, track_id, clip_id)
    key = (track_id, clip_id)
    base = {'stateVersion': version, 'setFingerprint': _set_fingerprint(song),
            'trackId': track_id, 'clipId': clip_id, 'location': 'arrangement' if timeline else 'session',
            'timeline': timeline, 'selectionToken': None, 'noteIds': None, 'notes': None,
            'editContext': {'frozen': _flag(track, 'is_frozen'), 'clipRecording': _flag(clip, 'is_recording'),
                            'arrangementRecord': _flag(song, 'record_mode'), 'sessionRecord': _flag(song, 'session_record'),
                            'countingIn': _flag(song, 'is_counting_in')}}
    if getattr(song.view, 'detail_clip', None) != clip:
        _contexts.pop(key, None)
        return {**base, 'status': 'not_detail_clip'}
    getter = getattr(clip, 'get_selected_notes_extended', None)
    if not callable(getter):
        _contexts.pop(key, None)
        return {**base, 'status': 'unavailable'}
    owners = tuple(song.tracks)
    notes = _notes(getter)
    if (_notes(getter) != notes or getattr(song.view, 'detail_clip', None) != clip
            or _midi_clip(song, track_id, clip_id) != (clip, timeline) or tuple(song.tracks) != owners):
        raise ValueError('MIDI note selection or target changed during read')
    binding = (song, owners, track, clip, timeline, notes)
    cached = _contexts.get(key)
    if cached is None or cached[0] != binding:
        if len(_contexts) >= 64: del _contexts[next(iter(_contexts))]
        cached = binding, str(uuid.uuid4())
        _contexts[key] = cached
    return {**base, 'status': 'selected' if notes else 'empty', 'selectionToken': cached[1],
            'noteIds': [note['noteId'] for note in notes], 'notes': notes}


def validate(song, params, version):
    current = context(song, params, version)
    token = params.get('expectedNoteSelectionToken')
    if (not isinstance(token, str) or not token or current['selectionToken'] != token
            or current['status'] != 'selected'):
        raise ValueError('MIDI note selection changed or is not available')
    if any(value is not False for value in current['editContext'].values()):
        raise ValueError('resolve frozen state, recording and count-in before selected-note edits')
    if any(change['noteId'] not in current['noteIds'] for change in params['changes']):
        raise ValueError('note-property changes must stay within the observed note selection')
