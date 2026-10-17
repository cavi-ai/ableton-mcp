"""Membership-aware crossfader inspection and guarded immediate changes."""
import math
import re
import uuid

try:
    from .bridge import _set_fingerprint, _parameter_automation_state, _track_type, _undo_step
except ImportError:
    from bridge import _set_fingerprint, _parameter_automation_state, _track_type, _undo_step

_identity = None
SIDES = {'A': 0, 'none': 1, 'B': 2}


def _request(params):
    if ('assignments' in params) == ('position' in params):
        raise ValueError('request assignments or position in separate confirmed steps')
    if 'position' in params:
        value = params['position']
        if type(value) not in (int, float) or not math.isfinite(value) or not -1 <= value <= 1:
            raise ValueError('crossfader position must be finite and between -1 and 1')
        return {'position': value}
    items = params['assignments']
    if not isinstance(items, list) or not 1 <= len(items) <= 64:
        raise ValueError('assignments require 1-64 exact track or Return targets')
    ids = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {'trackId', 'side'} or not isinstance(item['trackId'], str) or \
                not re.fullmatch(r'(?:track|return)-(0|[1-9][0-9]*)', item['trackId']) or item['side'] not in SIDES:
            raise ValueError('canonical track/Return ID and side A, none or B required')
        ids.append(item['trackId'])
    if len(set(ids)) != len(ids):
        raise ValueError('crossfader assignment targets must be unique')
    return {'assignments': [dict(item) for item in items]}


def _assignment(mixer):
    try:
        value = mixer.crossfade_assign
        if isinstance(value, bool): raise ValueError('invalid native assignment')
        if value != int(value): raise ValueError('invalid native assignment')
        value = int(value)
        return {'supported': True, 'value': value, 'name': next((k for k, v in SIDES.items() if v == value), None)}
    except Exception:
        return {'supported': False, 'value': None, 'name': None}


def _position(parameter):
    if parameter is None:
        return {'supported': False}
    try:
        value, minimum, maximum = float(parameter.value), float(parameter.min), float(parameter.max)
        if not all(math.isfinite(v) for v in (value, minimum, maximum)) or minimum >= maximum:
            return {'supported': False}
        return {'supported': True, 'value': value, 'min': minimum, 'max': maximum,
                'enabled': getattr(parameter, 'is_enabled', None), 'quantized': getattr(parameter, 'is_quantized', None),
                'automationState': _parameter_automation_state(parameter)}
    except Exception:
        return {'supported': False}


def _capture(song, version):
    tracks, returns, master = tuple(song.tracks), tuple(song.return_tracks), song.master_track
    if len(tracks) > 256 or len(returns) > 64:
        raise ValueError('crossfader supports at most 256 tracks and 64 Returns')
    owners = tracks + returns
    mixers = tuple(track.mixer_device for track in owners)
    parameter = getattr(master.mixer_device, 'crossfader', None)
    rows = []
    for i, (track, mixer) in enumerate(zip(owners, mixers)):
        ordinary = i < len(tracks)
        parent = getattr(track, 'group_track', None) if ordinary and bool(getattr(track, 'is_grouped', False)) else None
        parent_id = next((f'track-{n}' for n, t in enumerate(tracks) if t == parent), None)
        rows.append({'trackId': f'track-{i}' if ordinary else f'return-{i - len(tracks)}', 'name': track.name,
                     'type': _track_type(track) if ordinary else 'return', 'groupTrackId': parent_id,
                     'isGroup': bool(getattr(track, 'is_foldable', False)), 'mute': bool(track.mute), 'solo': bool(track.solo),
                     'assignment': _assignment(mixer)})
    view = {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'position': _position(parameter),
            'tracks': rows, 'assignmentChoices': [{'name': k, 'value': v} for k, v in SIDES.items()],
            'transport': {'isPlaying': bool(song.is_playing), 'arrangementRecord': bool(song.record_mode),
                          'sessionRecord': bool(song.session_record), 'countingIn': bool(getattr(song, 'is_counting_in', False))}}
    return view, (song, tracks, returns, master, master.mixer_device, mixers, parameter)


def context(song, params, version):
    global _identity
    view, binding = _capture(song, version)
    if _identity is None or _identity[0] != binding:
        _identity = binding, str(uuid.uuid4())
    return {**view, 'identityToken': _identity[1]}


def _safe(view, request):
    transport, position = view['transport'], view['position']
    if transport['arrangementRecord'] or transport['sessionRecord'] or transport['countingIn']:
        raise ValueError('resolve recording and count-in before changing crossfader state')
    if not position['supported'] or position['enabled'] is not True or position['quantized'] is not False:
        raise ValueError('native Main crossfader must be available, enabled and continuous')
    if position['automationState'] != {'value': 0, 'name': 'none'}:
        raise ValueError('Main crossfader automation must be known and inactive')
    selected = [item['trackId'] for item in request.get('assignments', [])]
    rows = {row['trackId']: row for row in view['tracks']}
    if any(key not in rows for key in selected):
        raise ValueError('crossfader target track or Return is unavailable')
    relevant = list(rows)
    if any(not rows[key]['assignment']['supported'] or rows[key]['assignment']['name'] is None for key in relevant):
        raise ValueError('native crossfader assignments must be available and known')
    if 'position' in request and not position['min'] <= request['position'] <= position['max']:
        raise ValueError('crossfader position is outside native bounds; no clamping')


def _owned(song, binding):
    _, current = _capture(song, 0)
    if current != binding:
        raise ValueError('native crossfader identity or topology changed')


def _metadata(row):
    return {key: value for key, value in row.items() if key != 'assignment'}


def begin(song, params, version):
    request = _request(params)
    before = context(song, {}, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('crossfader context or native identity changed')
    _safe(before, request)
    binding = _identity[0]
    operation = {'before': before, 'binding': binding, 'request': request, 'error': None, 'requested': [], 'positionRequested': False}
    rows = {row['trackId']: (i, row) for i, row in enumerate(before['tracks'])}
    try:
        with _undo_step(song):
            for item in request.get('assignments', []):
                _owned(song, binding)
                current, _ = _capture(song, version)
                _safe(current, request)
                if current['transport'] != before['transport'] or current['position'] != before['position']:
                    raise ValueError('Main crossfader or transport changed during assignments')
                for old, new in zip(before['tracks'], current['tracks']):
                    issued = next((r for r in operation['requested'] if r == old['trackId']), None)
                    allowed = [old['assignment']['value']]
                    if issued: allowed.append(SIDES[next(x['side'] for x in request['assignments'] if x['trackId'] == issued)])
                    if _metadata(old) != _metadata(new) or new['assignment']['value'] not in allowed:
                        raise ValueError('assignment context changed during crossfader setup')
                index, row = rows[item['trackId']]
                value = SIDES[item['side']]
                if row['assignment']['value'] != value:
                    operation['requested'].append(item['trackId'])
                    binding[5][index].crossfade_assign = value
            if 'position' in request and before['position']['value'] != request['position']:
                _owned(song, binding)
                current, _ = _capture(song, version)
                _safe(current, request)
                if current != {k: v for k, v in before.items() if k != 'identityToken'}:
                    raise ValueError('crossfader context changed before position write')
                operation['positionRequested'] = True
                binding[6].value = request['position']
            _owned(song, binding)
    except Exception as error:
        operation['error'] = str(error) or error.__class__.__name__
    return operation


def complete(song, operation, version):
    before, binding, request = operation['before'], operation['binding'], operation['request']
    result = {'stateVersion': version, 'verified': False, 'partial': True, 'error': operation['error'],
              'requestedAssignmentTrackIds': list(operation['requested']), 'positionWriteRequested': operation['positionRequested'],
              'request': request, 'observed': None}
    if song != binding[0]: return {**result, 'observationError': 'source Set changed'}
    try:
        view, current = _capture(song, version)
        safe, safety_error = True, None
        try: _safe(view, request)
        except Exception as error: safe, safety_error = False, str(error) or error.__class__.__name__
        wanted = {x['trackId']: SIDES[x['side']] for x in request.get('assignments', [])}
        assignments = all(row['assignment']['value'] == wanted.get(row['trackId'], old['assignment']['value']) and
                          row['assignment']['supported'] == old['assignment']['supported'] and _metadata(row) == _metadata(old)
                          for row, old in zip(view['tracks'], before['tracks']))
        target = request.get('position', before['position'].get('value'))
        position = view['position']['supported'] and target is not None and abs(view['position']['value'] - target) <= 1e-6
        checks = {'topologyStable': current == binding, 'assignmentsMatch': assignments, 'positionMatches': position,
                  'transportPreserved': view['transport'] == before['transport'], 'editSafetyPreserved': safe,
                  'recordingOff': not view['transport']['arrangementRecord'] and not view['transport']['sessionRecord'] and not view['transport']['countingIn']}
        verified = operation['error'] is None and all(checks.values())
        return {**result, 'verified': verified, 'partial': not verified, 'verification': checks, 'observed': view, 'safetyError': safety_error,
                'limitation': 'Immediate native requests and readback, not a timed fade, atomic audio transition or audible-balance verification. Partial work remains; no rollback or replay.'}
    except Exception as error:
        return {**result, 'observationError': str(error) or error.__class__.__name__}


def apply(song, params, version):
    return complete(song, begin(song, params, version), version + 1)
