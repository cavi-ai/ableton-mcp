"""Add explicit notes without rewriting existing notes or their expression."""
import math
import uuid
try:
    from .bridge import _midi_clip, _track, _midi_note_record, _new_midi_note, _clip_timing, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _midi_clip, _track, _midi_note_record, _new_midi_note, _clip_timing, _set_fingerprint, _undo_step

_song = None
_contexts = {}
_fields = ('pitch', 'start', 'duration', 'velocity', 'velocityDeviation', 'releaseVelocity', 'probability', 'mute')


def _flag(owner, name):
    try: value = getattr(owner, name, None)
    except Exception: return None
    return bool(value) if type(value) in (int, bool) and value in (0, 1) else None


def _notes(clip):
    result = []
    for note in clip.get_all_notes_extended():
        if len(result) >= 4096: raise ValueError('MIDI insertion supports at most 4096 existing or final notes')
        result.append(_midi_note_record(note))
    result.sort(key=lambda note: note['noteId'])
    if len({note['noteId'] for note in result}) != len(result): raise ValueError('duplicate native note IDs')
    return result


def context(song, params, version):
    global _song
    if _song != song:
        _song = song
        _contexts.clear()
    track_id, clip_id = params['trackId'], params['clipId']
    _, track = _track(song, track_id)
    clip, timeline = _midi_clip(song, track_id, clip_id)
    owners = tuple(song.tracks)
    binding = (song, owners, track, clip, timeline)
    key = (track_id, clip_id)
    cached = _contexts.get(key)
    if cached is None or cached[0] != binding:
        if len(_contexts) >= 64: del _contexts[next(iter(_contexts))]
        cached = binding, str(uuid.uuid4())
        _contexts[key] = cached
    def read():
        return {'notes': _notes(clip), 'clipTiming': _clip_timing(song, track_id, clip_id, version),
                'editContext': {'frozen': _flag(track, 'is_frozen'), 'clipRecording': _flag(clip, 'is_recording'),
                                'clipOverdubbing': _flag(clip, 'is_overdubbing'), 'pendingLaunch': _flag(clip, 'is_triggered'),
                                'arrangementRecord': _flag(song, 'record_mode'), 'sessionRecord': _flag(song, 'session_record'),
                                'countingIn': _flag(song, 'is_counting_in')}}
    snapshot = read()
    if (snapshot != read() or _midi_clip(song, track_id, clip_id) != (clip, timeline)
            or tuple(song.tracks) != owners): raise ValueError('MIDI insertion source changed during read')
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': cached[1],
            'trackId': track_id, 'clipId': clip_id, 'location': 'arrangement' if timeline is not None else 'session',
            'timeline': timeline, 'insertSupported': callable(getattr(clip, 'add_new_notes', None)), **snapshot}


def _additions(notes, existing):
    if not isinstance(notes, list) or not 1 <= len(notes) <= 4096 or len(notes) + len(existing) > 4096:
        raise ValueError('insert 1-4096 notes with at most 4096 final notes')
    result = []
    for spec in notes:
        if not isinstance(spec, dict) or set(spec) - set(_fields): raise ValueError('invalid new note fields')
        note = {'velocityDeviation': 0, 'releaseVelocity': 64, 'probability': 1., 'mute': False, **spec}
        if set(note) != set(_fields): raise ValueError('pitch, start, duration and velocity required')
        for key, low, high in [('pitch', 0, 127), ('velocity', 1, 127), ('velocityDeviation', -127, 127), ('releaseVelocity', 0, 127)]:
            if type(note[key]) is not int or not low <= note[key] <= high: raise ValueError('invalid note ' + key)
        for key in ('start', 'duration', 'probability'):
            if type(note[key]) not in (float, int) or not math.isfinite(note[key]): raise ValueError('invalid finite note ' + key)
        if (note['start'] < 0 or note['duration'] <= 0 or not math.isfinite(note['start'] + note['duration'])
                or not 0 <= note['probability'] <= 1 or type(note['mute']) is not bool): raise ValueError('invalid note values')
        for other in existing + result:
            if (note['pitch'] == other['pitch'] and max(note['start'], other['start']) <
                    min(note['start'] + note['duration'], other['start'] + other['duration'])):
                raise ValueError('same-pitch overlap would risk altering existing or added notes')
        result.append(note)
    return result


def _matches(actual, expected):
    return all(abs(actual[key] - expected[key]) <= 2e-7 if key in ('start', 'duration', 'probability')
               else actual[key] == expected[key] for key in _fields)


def apply(song, params, version):
    before = context(song, params, version)
    if params.get('expectedStateVersion') != version or before != params.get('before'):
        raise ValueError('MIDI insertion source changed after planning')
    if not before['insertSupported'] or any(value is not False for value in before['editContext'].values()):
        raise ValueError('resolve native insertion support, frozen state, recording, count-in and pending launch')
    additions = _additions(params.get('notes'), before['notes'])
    specs = tuple(_new_midi_note(note) for note in additions)
    clip, _ = _midi_clip(song, params['trackId'], params['clipId'])
    returned, native_returned, error = [], False, None
    attempted = False
    try:
        with _undo_step(song):
            # Recheck after undo-entry callbacks, before making any change.
            if context(song, params, version) != before: raise ValueError('MIDI insertion source changed before write')
            attempted = True
            try:
                returned = list(clip.add_new_notes(specs))
                native_returned = True
            except Exception as failure: error = str(failure)
    except Exception as failure:
        if not attempted: raise
        error = f'{error}; undo finalization: {failure}' if error else f'undo finalization: {failure}'
    observed, preserved, verified, added_ids = None, None, False, []
    try:
        observed = context(song, params, version + 1)
        old = {note['noteId']: note for note in before['notes']}
        current = {note['noteId']: note for note in observed['notes']}
        added_ids = sorted(set(current) - set(old))
        preserved = all(note_id in current and current[note_id] == note for note_id, note in old.items())
        added = sorted([current[note_id] for note_id in added_ids], key=lambda note: (note['pitch'], note['start']))
        expected = sorted(additions, key=lambda note: (note['pitch'], note['start']))
        timing = {**observed['clipTiming'], 'stateVersion': version}
        verified = (error is None and native_returned and preserved and observed['identityToken'] == before['identityToken']
                    and timing == before['clipTiming'] and len(added) == len(expected)
                    and all(type(note_id) is int for note_id in returned) and sorted(returned) == added_ids
                    and all(_matches(actual, wanted) for actual, wanted in zip(added, expected)))
        if not verified and error is None: error = 'native MIDI insertion readback did not match the confirmed plan'
    except Exception as failure:
        error = f'{error}; readback: {failure}' if error else f'readback: {failure}'
    return {'stateVersion': version + 1, 'trackId': params['trackId'], 'clipId': params['clipId'],
            'nativeReturned': native_returned, 'returnedNoteIds': returned, 'addedNoteIds': added_ids,
            'insertionVerified': verified, 'existingNotesPreserved': preserved,
            'hiddenExpressionVerified': False, 'error': error, 'observed': observed}
