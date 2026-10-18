"""Guard explicit note-property edits and retain actual partial native results."""
import math
import re
try:
    from .bridge import _midi_clip, _track, _midi_note_record, _undo_step
    from .midi_note_removal import context as _source_context
    from .midi_note_selection import validate as _validate_selection
except ImportError:
    from bridge import _midi_clip, _track, _midi_note_record, _undo_step
    from midi_note_removal import context as _source_context
    from midi_note_selection import validate as _validate_selection

_FIELDS = {'pitch': 'pitch', 'start': 'start_time', 'duration': 'duration', 'velocity': 'velocity',
           'velocityDeviation': 'velocity_deviation', 'releaseVelocity': 'release_velocity',
           'probability': 'probability', 'mute': 'mute'}
_RANGES = {'pitch': (0, 127, True), 'start': (0, math.inf, False), 'duration': (0, math.inf, False),
           'velocity': (1, 127, True), 'velocityDeviation': (-127, 127, True),
           'releaseVelocity': (0, 127, True), 'probability': (0, 1, False)}


def context(song, params, version):
    track_id, clip_id = params.get('trackId'), params.get('clipId')
    if not isinstance(track_id, str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)', track_id):
        raise ValueError('canonical ordinary track ID required')
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id)+r':(?:clip|arrangement-clip)-(?:0|[1-9][0-9]*)', clip_id):
        raise ValueError('canonical exact MIDI clip ID required')
    if len(song.tracks) > 256: raise ValueError('note-property edits support at most 256 tracks')
    _, owner = _track(song, track_id)
    collection = owner.arrangement_clips if ':arrangement-clip-' in clip_id else owner.clip_slots
    if len(collection) > 4096: raise ValueError('note-property edits support at most 4096 clips per collection')
    result = _source_context(song, params, version)
    result.pop('removeSupported')
    clip, _ = _midi_clip(song, track_id, clip_id)
    result['modifySupported'] = callable(getattr(clip, 'get_notes_by_id', None)) and callable(getattr(clip, 'apply_note_modifications', None))
    result['lengthBeats'] = float(clip.length)
    return result


def _changes(before, changes):
    if not isinstance(changes, list) or not 1 <= len(changes) <= 4096:
        raise ValueError('1-4096 explicit note-property changes required')
    old = {n['noteId']: n for n in before['notes']}
    seen, effective = set(), []
    for change in changes:
        if not isinstance(change, dict) or set(change) - (set(_FIELDS) | {'noteId', 'previous'}):
            raise ValueError('unsupported note-property fields')
        note_id = change.get('noteId')
        if type(note_id) is not int or note_id < 0 or note_id in seen or note_id not in old:
            raise ValueError('unique existing nonnegative native note IDs required')
        seen.add(note_id)
        previous = old[note_id]
        if change.get('previous') != previous: raise ValueError('prior note properties changed')
        properties = {k: v for k, v in change.items() if k in _FIELDS}
        if not properties: raise ValueError('at least one note property required')
        for key, value in properties.items():
            if key == 'mute':
                if type(value) is not bool: raise ValueError('mute must be boolean')
            else:
                low, high, integer = _RANGES[key]
                if (type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high
                        or (integer and value != int(value)) or (key == 'duration' and value <= 0)):
                    raise ValueError('note property outside its supported range')
        end = properties.get('start', previous['start']) + properties.get('duration', previous['duration'])
        if not math.isfinite(end) or end > before['lengthBeats']:
            raise ValueError('note edit extends beyond the clip')
        changed = {k: v for k, v in properties.items() if v != previous[k]}
        if changed: effective.append({'noteId': note_id, 'previous': previous, **changed})
    return sorted(effective, key=lambda change: change['noteId'])


def _recheck(song, params, version, before):
    if context(song, params, version) != before: raise ValueError('MIDI note-property source changed before write')
    if 'expectedNoteSelectionToken' in params: _validate_selection(song, params, version)


def apply(song, params, version):
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('propertyEditContext'):
        raise ValueError('MIDI note-property source changed after planning')
    if not before['modifySupported'] or any(flag is not False for flag in before['editContext'].values()):
        raise ValueError('resolve native modification support, frozen state, recording, count-in and pending launch')
    changes = _changes(before, params.get('changes'))
    _recheck(song, params, version, before)
    clip, _ = _midi_clip(song, params['trackId'], params['clipId'])
    attempted, returned, error = False, False, None
    try:
        if changes:
            with _undo_step(song):
                _recheck(song, params, version, before)
                native = clip.get_notes_by_id(tuple(c['noteId'] for c in changes))
                records = [_midi_note_record(n) for n in native]
                expected_prior = {c['noteId']: c['previous'] for c in changes}
                if len(records) != len(changes) or {n['noteId']: n for n in records} != expected_prior:
                    raise ValueError('native note vector changed before write')
                by_id = {c['noteId']: c for c in changes}
                for note in native:
                    change = by_id[int(note.note_id)]
                    for key, attribute in _FIELDS.items():
                        if key in change: setattr(note, attribute, change[key])
                _recheck(song, params, version, before)
                attempted = True
                clip.apply_note_modifications(native)
                returned = True
    except Exception as failure:
        if not attempted: raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {'stateVersion': version+1, 'trackId': params['trackId'], 'clipId': params['clipId'],
              'location': before['location'], 'timeline': before['timeline'], 'lengthBeats': before['lengthBeats'],
              'writeRequested': attempted, 'nativeReturned': returned, 'editVerified': False,
              'targetIdentityPreserved': None, 'noteIdsPreserved': None, 'unrequestedNotesPreserved': None,
              'clipTimingPreserved': None, 'hiddenExpressionVerified': False, 'notes': None,
              'observed': None, 'error': error, 'observationError': None}
    try:
        observed = context(song, params, version+1)
        old = {n['noteId']: n for n in before['notes']}
        current = {n['noteId']: n for n in observed['notes']}
        expected = {i: dict(n) for i, n in old.items()}
        for change in changes:
            expected[change['noteId']].update({k: v for k, v in change.items() if k in _FIELDS})
        changed_ids = {c['noteId'] for c in changes}
        identity = observed['identityToken'] == before['identityToken']
        ids_same = set(current) == set(old)
        untouched = all(current.get(i) == n for i, n in old.items() if i not in changed_ids)
        timing = {**observed['clipTiming'], 'stateVersion': version} == before['clipTiming']
        matched = ids_same and all(all(abs(current[i][k]-n[k]) <= 2e-7 if k in ('start', 'duration', 'probability') else current[i][k] == n[k] for k in _FIELDS) for i, n in expected.items())
        verified = error is None and (not attempted or returned) and identity and untouched and timing and matched
        requested_ids = {c['noteId'] for c in params['changes']}
        result.update(observed=observed, notes=[n for n in observed['notes'] if n['noteId'] in requested_ids],
                      editVerified=verified, targetIdentityPreserved=identity, noteIdsPreserved=ids_same,
                      unrequestedNotesPreserved=untouched, clipTimingPreserved=timing)
        if not verified and error is None: result['error'] = 'native MIDI note-property readback did not match the plan'
    except Exception as failure:
        result['observationError'] = (str(failure) or failure.__class__.__name__)[:600]
    return result
