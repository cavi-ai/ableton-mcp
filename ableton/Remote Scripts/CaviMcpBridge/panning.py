"""Mode-aware native mixer panning inspection and immediate guarded edits."""
import math
import re
import uuid

try:
    from .bridge import _device_owner, _set_fingerprint, _parameter_automation_state, _track_type, _undo_step
except ImportError:
    from bridge import _device_owner, _set_fingerprint, _parameter_automation_state, _track_type, _undo_step

MODES = {'stereo': 0, 'splitStereo': 1}
CONTROLS = {'pan': 'panning', 'left': 'left_split_stereo', 'right': 'right_split_stereo'}
_song = None
_identities = {}


def mode_record(mixer):
    try:
        value = mixer.panning_mode
        if isinstance(value, bool) or value != int(value): raise ValueError('invalid native mode')
        value = int(value)
        return {'supported': True, 'value': value, 'name': next((k for k, v in MODES.items() if v == value), None)}
    except Exception:
        return {'supported': False, 'value': None, 'name': None}


def require_stereo(mixer):
    if mode_record(mixer) != {'supported': True, 'value': 0, 'name': 'stereo'}:
        raise ValueError('single-pan edits require known Stereo mode; use mode-aware mixer panning for Split Stereo')


def _parameter(parameter):
    try:
        value, minimum, maximum = float(parameter.value), float(parameter.min), float(parameter.max)
        if not all(math.isfinite(x) for x in (value, minimum, maximum)) or minimum >= maximum:
            raise ValueError('invalid native pan bounds')
        try: display = parameter.str_for_value(value)
        except Exception: display = None
        return {'supported': True, 'value': value, 'min': minimum, 'max': maximum,
                'displayValue': display, 'enabled': getattr(parameter, 'is_enabled', None),
                'quantized': getattr(parameter, 'is_quantized', None), 'automationState': _parameter_automation_state(parameter)}
    except Exception:
        return {'supported': False}


def _capture(song, track_id, version):
    if not isinstance(track_id, str) or not re.fullmatch(r'(?:master|(?:track|return)-(?:0|[1-9][0-9]*))', track_id):
        raise ValueError('canonical track, Group, Return or master ID required')
    if len(song.tracks) > 256 or len(song.return_tracks) > 64:
        raise ValueError('mixer panning supports at most 256 tracks and 64 Returns')
    track_id, owner = _device_owner(song, track_id)
    mixer = owner.mixer_device
    parameters = tuple(getattr(mixer, attribute, None) for attribute in CONTROLS.values())
    kind = 'master' if track_id == 'master' else 'return' if track_id.startswith('return-') else _track_type(owner)
    view = {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'trackId': track_id,
            'name': getattr(owner, 'name', 'Main' if track_id == 'master' else None), 'type': kind,
            'frozen': getattr(owner, 'is_frozen', None) if track_id.startswith('track-') else False,
            'mode': mode_record(mixer), 'parameters': {key: _parameter(p) for key, p in zip(CONTROLS, parameters)},
            'transport': {'isPlaying': bool(song.is_playing), 'arrangementRecord': bool(song.record_mode),
                          'sessionRecord': bool(song.session_record), 'countingIn': bool(getattr(song, 'is_counting_in', False))}}
    return view, (song, owner, mixer, parameters)


def context(song, params, version):
    global _song
    view, binding = _capture(song, params.get('trackId'), version)
    if _song != song:
        _song = song
        _identities.clear()
    cached = _identities.get(view['trackId'])
    if cached is None or cached[0] != binding:
        cached = binding, str(uuid.uuid4())
        _identities[view['trackId']] = cached
    return {**view, 'identityToken': cached[1]}


def _request(params):
    controls = {key: params[key] for key in CONTROLS if key in params}
    if 'mode' in params:
        if controls or not isinstance(params['mode'], str) or params['mode'] not in MODES:
            raise ValueError('mode must be stereo or splitStereo in a separate confirmed step')
        return {'mode': params['mode']}
    if not controls or ('pan' in controls and len(controls) != 1):
        raise ValueError('request Stereo pan or Split Stereo left/right controls')
    if any(type(value) not in (int, float) or not math.isfinite(value) or not -1 <= value <= 1 for value in controls.values()):
        raise ValueError('native pan values must be finite and between -1 and 1; no clamping')
    return controls


def _safe(view, request):
    if view['mode']['name'] not in MODES:
        raise ValueError('native panning mode must be available and known')
    transport = view['transport']
    if transport['arrangementRecord'] or transport['sessionRecord'] or transport['countingIn']:
        raise ValueError('resolve recording and count-in before changing panning')
    if view['frozen'] is not False:
        raise ValueError('panning owner is frozen or freeze state is unavailable')
    if 'mode' not in request and view['mode']['name'] != ('stereo' if 'pan' in request else 'splitStereo'):
        raise ValueError('requested pan controls do not match the active native mode')
    for key in CONTROLS if 'mode' in request else request:
        p = view['parameters'][key]
        if not p['supported'] or p['quantized'] is not False or p['automationState'] != {'value': 0, 'name': 'none'}:
            raise ValueError('affected panning parameters must be available, continuous and have known inactive automation')
        if 'mode' not in request and (p['enabled'] is not True or not p['min'] <= request[key] <= p['max']):
            raise ValueError('active panning parameter must be enabled and target inside native bounds; no clamping')


def _metadata(view):
    return {k: v for k, v in view.items() if k not in ('stateVersion', 'parameters', 'mode', 'identityToken')}


def _parameter_metadata(record):
    return {k: v for k, v in record.items() if k not in ('value', 'displayValue')}


def begin(song, params, version):
    request = _request(params)
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('native panning context or identity changed')
    _safe(before, request)
    binding = _identities[before['trackId']][0]
    operation = {'before': before, 'binding': binding, 'request': request, 'error': None, 'requested': []}

    def recheck():
        current, native = _capture(song, before['trackId'], version)
        if native != binding: raise ValueError('native panning owner, mixer or parameter replaced')
        _safe(current, request)
        if _metadata(current) != _metadata(before) or current['mode'] != before['mode']:
            raise ValueError('panning mode, owner or transport changed during edit')
        for key, old in before['parameters'].items():
            new = current['parameters'][key]
            matches = new.get('value') == old.get('value')
            if key in operation['requested'] and new.get('value') is not None:
                matches = matches or abs(new['value'] - request[key]) <= 1e-6
            if _parameter_metadata(old) != _parameter_metadata(new) or not matches:
                raise ValueError('panning parameter context changed during edit')

    try:
        with _undo_step(song):
            recheck()
            if 'mode' in request:
                if before['mode']['name'] != request['mode']:
                    operation['requested'].append('mode')
                    binding[2].panning_mode = MODES[request['mode']]
            else:
                for key, value in request.items():
                    recheck()
                    if before['parameters'][key]['value'] != value:
                        operation['requested'].append(key)
                        binding[3][list(CONTROLS).index(key)].value = value
    except Exception as error:
        operation['error'] = str(error) or error.__class__.__name__
    return operation


def complete(song, operation, version):
    before, binding, request = operation['before'], operation['binding'], operation['request']
    result = {'stateVersion': version, 'verified': False, 'partial': True, 'error': operation['error'],
              'requestedControls': list(operation['requested']), 'request': request, 'observed': None}
    if song != binding[0]: return {**result, 'observationError': 'source Set changed'}
    try:
        view, current = _capture(song, before['trackId'], version)
        safe, safety_error = True, None
        try: _safe(view, request)
        except Exception as error: safe, safety_error = False, str(error) or error.__class__.__name__
        matches = all(view['parameters'][key]['supported'] and abs(view['parameters'][key]['value'] - value) <= 1e-6
                      for key, value in request.items() if key in CONTROLS)
        retained = 'mode' in request or all(
            view['parameters'][key] == old for key, old in before['parameters'].items() if key not in request)
        parameter_context = 'mode' in request or all(_parameter_metadata(view['parameters'][key]) == _parameter_metadata(old)
                                                     for key, old in before['parameters'].items())
        checks = {'topologyStable': current == binding, 'ownerContextPreserved': _metadata(view) == _metadata(before),
                  'modeMatches': view['mode']['name'] == request.get('mode', before['mode']['name']),
                  'requestedValuesMatch': matches,
                  **({'parameterContextPreserved': parameter_context} if 'mode' not in request else {}),
                  **({'unrequestedValuesPreserved': retained} if 'mode' not in request else {}),
                  'editSafetyPreserved': safe, 'recordingOff': not view['transport']['arrangementRecord'] and
                  not view['transport']['sessionRecord'] and not view['transport']['countingIn']}
        verified = operation['error'] is None and all(checks.values())
        return {**result, 'verified': verified, 'partial': not verified, 'verification': checks,
                'observed': view, 'safetyError': safety_error,
                'unrequestedValuesPreserved': None if 'mode' in request else retained,
                'limitation': 'Immediate native changes and readback, not a timed sweep or audible image verification. A mode switch may change all native pan controls; their observed values are reported. Partial work remains without rollback or replay.'}
    except Exception as error:
        return {**result, 'observationError': str(error) or error.__class__.__name__}


def apply(song, params, version):
    return complete(song, begin(song, params, version), version + 1)
