"""Explicit note-ID deletion with guarded sources and partial-work readback."""
import uuid
try:
    from .bridge import _midi_clip, _track, _midi_note_record, _clip_timing, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _midi_clip, _track, _midi_note_record, _clip_timing, _set_fingerprint, _undo_step

_song = None
_contexts = {}


def _flag(owner, name):
    try: value = getattr(owner, name, None)
    except Exception: return None
    return bool(value) if type(value) in (int, bool) and value in (0, 1) else None


def _notes(clip):
    result = []
    for note in clip.get_all_notes_extended():
        if len(result) >= 4096: raise ValueError('note removal supports at most 4096 existing notes; no sampling')
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
            or tuple(song.tracks) != owners): raise ValueError('MIDI removal source changed during read')
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': cached[1],
            'trackId': track_id, 'clipId': clip_id, 'location': 'arrangement' if timeline is not None else 'session',
            'timeline': timeline, 'removeSupported': callable(getattr(clip, 'remove_notes_by_id', None)), **snapshot}


def apply(song, params, version):
    before = context(song, params, version)
    if params.get('expectedStateVersion') != version or before != params.get('before'):
        raise ValueError('MIDI removal source changed after planning')
    if not before['removeSupported'] or any(value is not False for value in before['editContext'].values()):
        raise ValueError('resolve native removal support, frozen state, recording, count-in and pending launch')
    ids = params.get('noteIds')
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 4096
            or any(type(note_id) is not int or note_id < 0 for note_id in ids)
            or len(set(ids)) != len(ids)):
        raise ValueError('1-4096 unique nonnegative integer note IDs required')
    old = {note['noteId']: note for note in before['notes']}
    targets = set(ids)
    if not targets.issubset(old): raise ValueError('one or more requested note IDs no longer exist')
    clip, _ = _midi_clip(song, params['trackId'], params['clipId'])
    attempted, native_returned, error = False, False, None
    try:
        with _undo_step(song):
            if context(song, params, version) != before: raise ValueError('MIDI removal source changed before write')
            attempted = True
            try:
                clip.remove_notes_by_id(tuple(sorted(targets)))
                native_returned = True
            except Exception as failure: error = str(failure)
    except Exception as failure:
        if not attempted: raise
        error = f'{error}; undo finalization: {failure}' if error else f'undo finalization: {failure}'
    observed, removed, remaining, added, preserved, identity = None, None, None, None, None, None
    verified = False
    try:
        observed = context(song, params, version + 1)
        identity = observed['identityToken'] == before['identityToken']
        if not identity: raise ValueError('native clip target changed during removal readback')
        current = {note['noteId']: note for note in observed['notes']}
        removed, remaining = sorted(set(old) - set(current)), sorted(targets.intersection(current))
        added = sorted(set(current) - set(old))
        preserved = all(note_id in current and current[note_id] == note
                        for note_id, note in old.items() if note_id not in targets)
        timing = {**observed['clipTiming'], 'stateVersion': version}
        verified = (error is None and native_returned and preserved and set(removed) == targets
                    and not remaining and not added and timing == before['clipTiming'])
        if not verified and error is None: error = 'native MIDI removal readback did not match the confirmed plan'
    except Exception as failure:
        error = f'{error}; readback: {failure}' if error else f'readback: {failure}'
    return {'stateVersion': version + 1, 'trackId': params['trackId'], 'clipId': params['clipId'],
            'nativeReturned': native_returned, 'removalVerified': verified, 'removedNoteIds': removed,
            'remainingRequestedNoteIds': remaining, 'unexpectedAddedNoteIds': added,
            'unrequestedNotesPreserved': preserved, 'targetIdentityPreserved': identity,
            'deletedExpressionBackedUp': False, 'error': error, 'observed': observed}
