"""Inspect exact automation controls and hand one overridden control back to Live."""
import math
import re
import uuid

try:
    from .bridge import _device_owner, _device, _set_fingerprint, _track_type, _parameter_automation_state, _undo_step
except ImportError:
    from bridge import _device_owner, _device, _set_fingerprint, _track_type, _parameter_automation_state, _undo_step

_song = None
_identities = {}
_mixer = {'volume': 'volume', 'pan': 'panning', 'left': 'left_split_stereo', 'right': 'right_split_stereo'}


def _objects(song, params):
    track_id, device_id = params.get('trackId'), params.get('deviceId')
    if not isinstance(track_id, str) or not re.fullmatch(r'(?:master|(?:track|return)-(?:0|[1-9][0-9]*))', track_id):
        raise ValueError('canonical track, Group, Return or master ID required')
    if len(song.tracks) > 256 or len(song.return_tracks) > 64:
        raise ValueError('automation context supports at most 256 tracks and 64 Returns')
    _, owner = _device_owner(song, track_id)
    related = ()
    lineage = ()
    if device_id is not None:
        if not isinstance(device_id, str) or len(device_id.split('/')) > 33 or not re.fullmatch(re.escape(track_id) +
                r':device-(?:0|[1-9][0-9]*)(?:/(?:chain|return-chain)-(?:0|[1-9][0-9]*)/device-(?:0|[1-9][0-9]*))*', device_id):
            raise ValueError('canonical device path on the exact owner required')
        _, _, device = _device(song, track_id, device_id)
        parts = device_id[len(track_id + ':device-'):].split('/')
        lineage = tuple(_device(song, track_id, track_id + ':device-' + '/'.join(parts[:end]))[::2]
                        for end in range(1, len(parts) + 1, 2))
        parameters = tuple(device.parameters)
        if len(parameters) > 2048: raise ValueError('device exceeds 2048 controls')
        specs = [(f'parameter-{index}', parameter, {}) for index, parameter in enumerate(parameters)]
    else:
        device = owner.mixer_device
        specs = [(key, getattr(device, attribute, None), {}) for key, attribute in _mixer.items()]
        if track_id != 'master':
            related = tuple(song.return_tracks)
            sends = tuple(device.sends)
            if len(sends) > 64 or len(sends) != len(related): raise ValueError('native send/Return layout is unresolved')
            specs += [(f'send-{index}', parameter, {'returnTrackId': f'return-{index}', 'returnName': related[index].name})
                      for index, parameter in enumerate(sends)]
        else:
            specs += [(key, getattr(device, attribute, None), {}) for key, attribute in
                      [('cueVolume', 'cue_volume'), ('crossfader', 'crossfader')]]
        parameters = tuple(row[1] for row in specs)
    selected = params.get('parameterId')
    rows = specs if selected is None else [row for row in specs if row[0] == selected]
    if selected is not None and (not isinstance(selected, str) or len(rows) != 1):
        raise ValueError('exact observed parameterId required')
    return owner, device, rows, (song, owner, device, parameters, related, lineage)


def _record(key, parameter, extra):
    base = {'id': key, **extra, 'supported': False, 'reEnableSupported': callable(getattr(parameter, 're_enable_automation', None))}
    try:
        value, low, high = float(parameter.value), float(parameter.min), float(parameter.max)
        if not all(math.isfinite(v) for v in (value, low, high)) or low >= high or not low <= value <= high:
            raise ValueError('invalid native parameter value or bounds')
        try: display = parameter.str_for_value(value)
        except Exception: display = None
        return {**base, 'supported': True, 'name': parameter.name, 'originalName': parameter.original_name,
                'value': value, 'min': low, 'max': high, 'displayValue': display,
                'enabled': getattr(parameter, 'is_enabled', None), 'quantized': getattr(parameter, 'is_quantized', None),
                'automationState': _parameter_automation_state(parameter)}
    except Exception:
        return base


def _mode(device):
    try:
        value = device.panning_mode
        if isinstance(value, bool) or value != int(value) or int(value) not in (0, 1): return None
        return int(value)
    except Exception: return None


def context(song, params, version):
    global _song
    owner, device, rows, binding = _objects(song, params)
    track_id, device_id, selected = params['trackId'], params.get('deviceId'), params.get('parameterId')
    controls = [_record(*row) for row in rows]
    if _objects(song, params)[3] != binding: raise ValueError('native automation target changed during read')
    if _song != song:
        _song = song
        _identities.clear()
    key = (track_id, device_id, selected)
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if key not in _identities and len(_identities) >= 1024: del _identities[next(iter(_identities))]
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    kind = 'master' if track_id == 'master' else 'return' if track_id.startswith('return-') else _track_type(owner)
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': cached[1],
            'trackId': track_id, 'deviceId': device_id, 'parameterId': selected, 'ownerType': kind,
            'name': getattr(owner, 'name', 'Main' if kind == 'master' else None),
            'deviceName': getattr(device, 'name', None) if device_id is not None else None,
            'frozen': getattr(owner, 'is_frozen', None) if track_id.startswith('track-') else False,
            'panningMode': _mode(device) if device_id is None and selected in (None, 'pan', 'left', 'right') else None,
            'transport': {'isPlaying': bool(song.is_playing), 'arrangementRecord': bool(song.record_mode),
                          'sessionRecord': bool(song.session_record), 'countingIn': bool(getattr(song, 'is_counting_in', False))},
            'controls': controls}


def _safe(view, allow_active=False):
    if view['parameterId'] is None or len(view['controls']) != 1: raise ValueError('select one exact parameterId')
    p = view['controls'][0]
    if not p['supported'] or not p['reEnableSupported']: raise ValueError('native automation handoff is not supported for this control')
    if p.get('enabled') is not True: raise ValueError('automation control must be enabled')
    states = [{'value': 2, 'name': 'overridden'}]
    if allow_active: states.append({'value': 1, 'name': 'playing'})
    if p.get('automationState') not in states:
        raise ValueError('control must have known active or overridden automation' if allow_active else 'control must have known overridden automation')
    if view['frozen'] is not False: raise ValueError('target is frozen or freeze state unavailable')
    t = view['transport']
    if t['arrangementRecord'] or t['sessionRecord'] or t['countingIn']: raise ValueError('resolve recording and count-in before automation handoff')
    if view['deviceId'] is None and p['id'] in ('pan', 'left', 'right') and view['panningMode'] != (0 if p['id'] == 'pan' else 1):
        raise ValueError('selected pan control does not match a known active native mode')


def begin(song, params, version):
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('native automation target, value or identity changed')
    _safe(before)
    owner, device, rows, binding = _objects(song, params)
    operation = {'before': before, 'params': {key: params[key] for key in ('trackId', 'deviceId', 'parameterId') if key in params},
                 'binding': binding, 'requested': False, 'nativeReturned': False, 'error': None}
    try:
        with _undo_step(song):
            current = context(song, params, version)
            if current != before: raise ValueError('automation context changed at undo entry')
            _safe(current)
            if _objects(song, params)[3] != binding: raise ValueError('native automation target changed before handoff')
            operation['requested'] = True
            rows[0][1].re_enable_automation()
            operation['nativeReturned'] = True
    except Exception as error:
        if not operation['requested']: raise
        operation['error'] = (str(error) or error.__class__.__name__)[:600]
    return operation


def _metadata(view):
    result = {key: value for key, value in view.items() if key not in ('stateVersion', 'identityToken', 'controls')}
    result['controls'] = [{key: value for key, value in row.items() if key not in ('value', 'displayValue', 'automationState')} for row in view['controls']]
    return result


def complete(song, operation, version):
    result = {'stateVersion': version, 'verified': False, 'partial': True, 'reEnableRequested': operation['requested'],
              'nativeReturned': operation['nativeReturned'], 'automationControlRestored': False, 'error': operation['error'], 'observed': None}
    try:
        if song != operation['binding'][0]: raise ValueError('source Set changed')
        view = context(song, operation['params'], version)
        stable = _objects(song, operation['params'])[3] == operation['binding']
        t = view['transport']
        active = len(view['controls']) == 1 and view['controls'][0].get('automationState') == {'value': 1, 'name': 'playing'}
        checks = {'topologyStable': stable, 'recordingOff': not t['arrangementRecord'] and not t['sessionRecord'] and not t['countingIn'],
                  'contextPreserved': _metadata(view) == _metadata(operation['before']), 'automationActive': active}
        verified = operation['error'] is None and operation['requested'] and operation['nativeReturned'] and all(checks.values())
        return {**result, 'verified': verified, 'partial': not verified, 'automationControlRestored': stable and active,
                'verification': checks, 'observed': view,
                'limitation': 'Native automation-state readback only; not envelope-content, value-trajectory or audible proof. One control is requested once. Partial work remains without rollback or replay.'}
    except Exception as error:
        return {**result, 'observationError': (str(error) or error.__class__.__name__)[:600]}


def apply(song, params, version):
    return complete(song, begin(song, params, version), version + 1)
