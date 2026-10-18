"""Read and change one device's local power without taking over automation."""
try:
    from . import parameter_automation as automation
    from .bridge import _device_record, _set_fingerprint, _undo_step
except ImportError:
    import parameter_automation as automation
    from bridge import _device_record, _set_fingerprint, _undo_step


def _flag(obj, name):
    try: value = getattr(obj, name, None)
    except Exception: return None
    return bool(value) if type(value) in (bool, int) and value in (0, 1) else None


def context(song, params, version):
    if not params.get('deviceId'): raise ValueError('exact deviceId required')
    ids = {key: params[key] for key in ('trackId', 'deviceId')}
    owner, device, rows, binding = automation._objects(song, ids)
    matches = [row for row in rows if getattr(row[1], 'original_name', None) == 'Device On']
    power, view = None, None
    if len(matches) == 1:
        view = automation.context(song, {**ids, 'parameterId': matches[0][0]}, version)
        power = view['controls'][0]
    supported = bool(power and power.get('supported') is True and power.get('quantized') is True
                     and power.get('min') == 0 and power.get('max') == 1 and power.get('value') in (0, 1))
    ancestors = [{'name': ancestor.name, 'className': ancestor.class_name, 'active': _flag(ancestor, 'is_active')}
                 for _, ancestor in binding[5][:-1]]
    result = {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), **ids,
              'supported': supported, 'device': _device_record(device, ids['deviceId']),
              'localActive': bool(power['value']) if supported else None,
              'effectiveActive': _flag(device, 'is_active'), 'ancestors': ancestors,
              'powerControl': power, 'automationContext': view,
              'editContext': {'frozen': _flag(owner, 'is_frozen') if ids['trackId'].startswith('track-') else False,
                              'arrangementRecord': _flag(song, 'record_mode'), 'sessionRecord': _flag(song, 'session_record'),
                              'countingIn': _flag(song, 'is_counting_in')}}
    if automation._objects(song, ids)[3] != binding: raise ValueError('native device activation target changed during read')
    return result


def _safe(view):
    power = view['powerControl']
    if (not view['supported'] or power.get('enabled') is not True
            or power.get('automationState') not in ({'value': 0, 'name': 'none'}, {'value': 2, 'name': 'overridden'})):
        raise ValueError('unique enabled binary Device On with known inactive or already overridden automation required')
    if any(value is not False for value in view['editContext'].values()):
        raise ValueError('resolve recording, count-in and frozen or unknown owner state before bypass')
    if view['effectiveActive'] is None or any(row['active'] is None for row in view['ancestors']):
        raise ValueError('native device and enclosing rack activation states must be known')


def apply(song, params, version):
    before = context(song, params, version)
    if (type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version
            or params.get('before') != before):
        raise ValueError('device activation identity, value or context changed; review a fresh plan')
    if type(params.get('active')) is not bool: raise ValueError('active must be boolean')
    _safe(before)
    ids = {key: params[key] for key in ('trackId', 'deviceId')}
    _, _, rows, binding = automation._objects(song, {**ids, 'parameterId': before['powerControl']['id']})
    attempted, returned, error = False, False, None
    try:
        if before['localActive'] != params['active']:
            with _undo_step(song):
                current = context(song, params, version)
                if current != before or automation._objects(song, ids)[3] != binding:
                    raise ValueError('native device activation changed before write')
                _safe(current)
                attempted = True
                rows[0][1].value = 1. if params['active'] else 0.
                returned = True
    except Exception as failure:
        if not attempted: raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {'stateVersion': version + 1, **ids, 'valueWriteRequested': attempted, 'nativeReturned': returned,
              'verified': False, 'error': error, 'after': None, 'device': None}
    try:
        after = context(song, params, version + 1)
        power, old = after['powerControl'], before['powerControl']
        checks = {'identityPreserved': automation._objects(song, ids)[3] == binding,
                  'localValueObserved': after['localActive'] is params['active'],
                  'automationPreserved': power is not None and power.get('automationState') == old['automationState'],
                  'metadataPreserved': power is not None and {k:v for k,v in power.items() if k not in ('value','displayValue')} ==
                                       {k:v for k,v in old.items() if k not in ('value','displayValue')},
                  'contextPreserved': after['editContext'] == before['editContext'] and after['ancestors'] == before['ancestors'],
                  'playbackPreserved': after['automationContext'] is not None and
                                       after['automationContext']['transport'] == before['automationContext']['transport']}
        verified = error is None and (not attempted or returned) and all(checks.values())
        return {**result, 'verified': verified, 'after': after, 'device': after['device'], 'verification': checks,
                'error': error if verified or error else 'device activation readback did not match the plan'}
    except Exception as failure:
        return {**result, 'observationError': (str(failure) or failure.__class__.__name__)[:600]}
