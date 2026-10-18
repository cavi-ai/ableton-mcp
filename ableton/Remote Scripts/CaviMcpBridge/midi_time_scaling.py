"""Scale exact stored MIDI note times without resizing the clip or changing tempo."""
import math
try:
    from .midi_note_removal import context
    from .bridge import _midi_clip, _undo_step
except ImportError:
    from midi_note_removal import context
    from bridge import _midi_clip, _undo_step


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _changes(before, params):
    operation = params['operation']
    if set(operation) != {'type', 'factor', 'originBeats'} or operation['type'] != 'scaleTime':
        raise ValueError('scaleTime requires only type, factor and originBeats')
    factor, origin = operation['factor'], operation['originBeats']
    timing = before['clipTiming']
    region = timing['loop'] if timing['loop']['enabled'] else timing['markers']
    start, end = region.get('startBeats'), region.get('endBeats')
    if (not _number(factor) or not .25 <= factor <= 4 or factor == 1
            or timing['markers'].get('unit') != 'beats' or type(timing['loop']['enabled']) is not bool
            or not _number(start) or not _number(end) or not 0 <= start < end
            or not _number(origin) or not start <= origin < end):
        raise ValueError('invalid MIDI scaling factor, clip-beat origin or playback bounds')
    ids = params.get('noteIds')
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 4096
            or any(type(i) is not int or i < 0 for i in ids) or len(set(ids)) != len(ids)):
        raise ValueError('unique nonnegative integer note IDs required')
    old = {n['noteId']: n for n in before['notes']}
    if not set(ids).issubset(old): raise ValueError('unknown note ID')
    changes = []
    for note_id in sorted(ids):
        note = old[note_id]
        position, duration = origin + (note['start'] - origin) * factor, note['duration'] * factor
        if (not _number(position) or not _number(duration) or duration < 1e-6
                or position < start or position + duration > end):
            raise ValueError('scaled notes exceed playback bounds or minimum duration')
        changes.append({'noteId': note_id, 'previous': note, 'start': position, 'duration': duration})
    final = {i: {**n} for i, n in old.items()}
    for c in changes: final[c['noteId']].update(start=c['start'], duration=c['duration'])
    targets = set(ids)
    ordered = sorted(final.values(), key=lambda note: (note['pitch'], note['start']))
    for note, other in zip(ordered[1:], ordered):
        if ((note['noteId'] in targets or other['noteId'] in targets) and note['pitch'] == other['pitch']
                and abs(note['start'] - other['start']) < 1e-9):
            raise ValueError('MIDI scaling creates a same-pitch onset collision')
    if changes != params.get('changes') or params.get('newNotes') != []:
        raise ValueError('derived MIDI scaling changes differ from plan')
    return changes, final


def apply(song, params, version):
    before = context(song, params, version)
    if before != params.get('before') or params.get('expectedStateVersion') != version:
        raise ValueError('MIDI scaling source changed after planning')
    if any(value is not False for value in before['editContext'].values()):
        raise ValueError('resolve frozen state, recording, count-in and pending launch')
    changes, expected = _changes(before, params)
    clip, _ = _midi_clip(song, params['trackId'], params['clipId'])
    if not callable(getattr(clip, 'apply_note_modifications', None)):
        raise ValueError('native MIDI modification unsupported')
    attempted, returned, error = False, False, None
    try:
        with _undo_step(song):
            if context(song, params, version) != before: raise ValueError('MIDI scaling source changed before write')
            notes = clip.get_notes_by_id(tuple(c['noteId'] for c in changes))
            by_id = {int(n.note_id): n for n in notes}
            if len(notes) != len(changes) or set(by_id) != {c['noteId'] for c in changes}:
                raise ValueError('MIDI scaling note targets changed')
            attempted = True
            for change in changes:
                note = by_id[change['noteId']]
                note.start_time, note.duration = change['start'], change['duration']
            clip.apply_note_modifications(notes)
            returned = True
    except Exception as failure:
        if not attempted: raise
        error = str(failure)
    observed, verified = None, False
    try:
        observed = context(song, params, version + 1)
        timing = {**observed['clipTiming'], 'stateVersion': version}
        actual = {n['noteId']: n for n in observed['notes']}
        exact = ('pitch', 'velocity', 'velocityDeviation', 'releaseVelocity', 'probability', 'mute')
        verified = (returned and error is None and observed['identityToken'] == before['identityToken']
                    and observed['setFingerprint'] == before['setFingerprint'] and timing == before['clipTiming']
                    and set(actual) == set(expected) and all(
                        all(actual[i][key] == n[key] for key in exact)
                        and abs(actual[i]['start'] - n['start']) <= 2e-7
                        and abs(actual[i]['duration'] - n['duration']) <= 2e-7 for i, n in expected.items()))
        if not verified and error is None: error = 'native MIDI scaling readback differs from plan'
    except Exception as failure:
        error = f'{error}; readback: {failure}' if error else f'readback: {failure}'
    return {'stateVersion': version + 1, 'trackId': params['trackId'], 'clipId': params['clipId'],
            'nativeReturned': returned, 'timeScalingVerified': verified, 'error': error, 'observed': observed}
