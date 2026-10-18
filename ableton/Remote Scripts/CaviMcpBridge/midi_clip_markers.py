"""Guard source-beat MIDI marker edits without rebuilding stored notes."""
import copy
import math
import re
try:
    from .bridge import _midi_clip, _track, _undo_step
    from .midi_note_removal import context as _source_context
except ImportError:
    from bridge import _midi_clip, _track, _undo_step
    from midi_note_removal import context as _source_context

_FIELDS = {'startBeats': 'start_marker', 'endBeats': 'end_marker'}
_EPSILON = 2e-7


def context(song, params, version):
    track_id, clip_id = params.get('trackId'), params.get('clipId')
    if not isinstance(track_id, str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)', track_id):
        raise ValueError('canonical ordinary track ID required')
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id)+r':(?:clip|arrangement-clip)-(?:0|[1-9][0-9]*)', clip_id):
        raise ValueError('canonical exact MIDI clip ID required')
    if len(song.tracks) > 256: raise ValueError('MIDI markers support at most 256 tracks')
    _, track = _track(song, track_id)
    clips = track.arrangement_clips if ':arrangement-clip-' in clip_id else track.clip_slots
    if len(clips) > 4096: raise ValueError('MIDI markers support at most 4096 clips per collection')
    clip, _ = _midi_clip(song, track_id, clip_id)
    if getattr(clip, 'is_audio_clip', None) is not False: raise ValueError('exact MIDI clip required')
    result = _source_context(song, params, version)
    result.pop('removeSupported')
    markers = result['clipTiming']['markers']
    values = [markers.get(k) for k in _FIELDS]
    result['markersSupported'] = (markers.get('supported') is True and markers.get('unit') == 'beats'
                                  and all(type(v) in (int, float) and math.isfinite(v) for v in values)
                                  and 0 <= values[0] < values[1])
    return result


def _target(markers):
    if not isinstance(markers, dict) or set(markers) != set(_FIELDS):
        raise ValueError('complete startBeats/endBeats marker target required')
    start, end = markers['startBeats'], markers['endBeats']
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in (start, end)) or not 0 <= start < end:
        raise ValueError('finite increasing nonnegative marker range required')
    return markers


def _same(current, expected, owned):
    compared = copy.deepcopy(current)
    for key in owned:
        try:
            actual, wanted = compared['clipTiming']['markers'][key], expected['clipTiming']['markers'][key]
            if abs(actual-wanted) > _EPSILON: return False
            compared['clipTiming']['markers'][key] = wanted
        except (KeyError, TypeError): return False
    return compared == expected


def apply(song, params, version):
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('MIDI marker source changed after planning')
    if not before['markersSupported'] or any(flag is not False for flag in before['editContext'].values()):
        raise ValueError('resolve native markers, frozen state, recording, count-in and pending launch')
    if before['clipTiming']['loop'].get('enabled') is not True:
        raise ValueError('MIDI marker edits require a loop-enabled clip; use separately scoped clip timing for finite phrases')
    target = _target(params.get('markers'))
    old = before['clipTiming']['markers']
    order = ('endBeats', 'startBeats') if target['startBeats'] >= old['endBeats'] else ('startBeats', 'endBeats')
    writes = [key for key in order if target[key] != old[key]]
    clip, _ = _midi_clip(song, params['trackId'], params['clipId'])
    expected, attempted, completed, error = copy.deepcopy(before), [], [], None
    try:
        if writes:
            with _undo_step(song):
                for key in writes:
                    if not _same(context(song, params, version), expected, completed):
                        raise ValueError('MIDI marker source changed before write')
                    attempted.append(key)
                    setattr(clip, _FIELDS[key], target[key])
                    completed.append(key)
                    expected['clipTiming']['markers'][key] = target[key]
    except Exception as failure:
        if not attempted: raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {'stateVersion': version+1, 'trackId': params['trackId'], 'clipId': params['clipId'],
              'writeRequested': bool(attempted), 'nativeReturned': bool(attempted) and len(completed) == len(writes),
              'attemptedFields': attempted, 'completedFields': completed, 'markersVerified': False,
              'targetIdentityPreserved': None, 'notesPreserved': None, 'loopPreserved': None,
              'unrequestedTimingPreserved': None, 'hiddenExpressionVerified': False,
              'observed': None, 'error': error, 'observationError': None}
    try:
        observed = context(song, params, version+1)
        normalized = {**observed, 'stateVersion': version,
                      'clipTiming': {**observed['clipTiming'], 'stateVersion': version}}
        identity = observed['identityToken'] == before['identityToken']
        notes = observed['notes'] == before['notes']
        loop = observed['clipTiming']['loop'] == before['clipTiming']['loop']
        other = {**normalized['clipTiming'], 'markers': old} == before['clipTiming']
        wanted = copy.deepcopy(before)
        wanted['clipTiming']['markers'].update(target)
        verified = error is None and (not attempted or len(completed) == len(writes)) and _same(normalized, wanted, completed)
        result.update(observed=observed, markersVerified=verified, targetIdentityPreserved=identity,
                      notesPreserved=notes, loopPreserved=loop, unrequestedTimingPreserved=other)
        if not verified and error is None: result['error'] = 'native MIDI marker readback did not match the plan'
    except Exception as failure:
        result['observationError'] = (str(failure) or failure.__class__.__name__)[:600]
    return result
