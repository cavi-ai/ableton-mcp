"""Explicitly take one automated control into manual control with one value write."""
import math

try:
    from . import parameter_automation as automation, parameter_display as displays
except ImportError:
    import parameter_automation as automation
    import parameter_display as displays


def _binding_view(view):
    control = view['controls'][0]
    if control['automationState'] == {'value': 1, 'name': 'playing'}:
        control = {key: value for key, value in control.items() if key not in ('value', 'displayValue')}
    return {**view, 'controls': [control]}


def _canonical(source):
    return {key: value for key, value in source.items() if key != 'sampledControl'}


def source(song, params, version):
    view = automation.context(song, params, version)
    automation._safe(view, allow_active=True)
    _, _, rows, binding = automation._objects(song, params)
    control, parameter = view['controls'][0], rows[0][1]
    if type(control.get('quantized')) is not bool:
        raise ValueError('native quantization state unavailable')
    raw, display = params.get('value'), params.get('targetDisplay')
    if (raw is not None) == (display is not None):
        raise ValueError('provide exactly one finite value or targetDisplay')
    if display is not None:
        if control['quantized']: raise ValueError('unit display targets require a continuous control')
        # Resolve independently of the currently moving automation value.
        target = displays._target(parameter, displays._quantity(display), include_current=False)
    else:
        if type(raw) not in (int, float) or not math.isfinite(raw) or not control['min'] <= raw <= control['max']:
            raise ValueError('value must be finite and inside native bounds; no clamping')
        if control['quantized'] and raw != int(raw): raise ValueError('quantized control requires an integer value')
        try: label = parameter.str_for_value(raw)
        except Exception: label = None
        target = {'value': raw, 'displayValue': label}
    current = automation.context(song, params, version)
    if automation._objects(song, params)[3] != binding or _binding_view(current) != _binding_view(view):
        raise ValueError('native automation control changed during target resolution')
    return {**_binding_view(view), 'valuePolicy': 'advancingAutomation' if control['automationState']['value'] == 1 else 'manualValueBound',
            'target': target, 'sampledControl': current['controls'][0]}


def begin(song, params, version):
    before = _canonical(source(song, params, version))
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('automation control, target or manual context changed; review a fresh plan')
    _, _, rows, binding = automation._objects(song, params)
    operation = {'before': {key: value for key, value in before.items() if key not in ('target', 'valuePolicy')},
                 'params': {key: params[key] for key in ('trackId', 'deviceId', 'parameterId') if key in params},
                 'target': before['target'], 'binding': binding, 'requested': False, 'nativeReturned': False, 'error': None}
    try:
        with automation._undo_step(song):
            if _canonical(source(song, params, version)) != before or automation._objects(song, params)[3] != binding:
                raise ValueError('automation control changed at undo entry')
            operation['requested'] = True
            rows[0][1].value = before['target']['value']
            operation['nativeReturned'] = True
    except Exception as error:
        if not operation['requested']: raise
        operation['error'] = (str(error) or error.__class__.__name__)[:600]
    return operation


def complete(song, operation, version):
    result = {'stateVersion': version, 'verified': False, 'partial': True, 'valueWriteRequested': operation['requested'],
              'nativeReturned': operation['nativeReturned'], 'automationOverridden': False, 'error': operation['error'], 'observed': None}
    try:
        if song != operation['binding'][0]: raise ValueError('source Set changed')
        view = automation.context(song, operation['params'], version)
        stable = automation._objects(song, operation['params'])[3] == operation['binding']
        control, target, transport = view['controls'][0], operation['target'], view['transport']
        overridden = control.get('automationState') == {'value': 2, 'name': 'overridden'}
        value_matches = control.get('supported') is True and abs(control['value'] - target['value']) <= 1e-6
        display_matches = None
        if 'quantity' in target:
            try: display_matches = displays._equal(displays._quantity(control.get('displayValue')), target['quantity'])
            except Exception: display_matches = False
        checks = {'topologyStable': stable, 'recordingOff': not transport['arrangementRecord'] and not transport['sessionRecord'] and not transport['countingIn'],
                  'contextPreserved': automation._metadata(view) == automation._metadata(operation['before']),
                  'automationOverridden': overridden, 'targetValueObserved': value_matches, 'targetDisplayObserved': display_matches}
        verified = operation['requested'] and operation['nativeReturned'] and operation['error'] is None and \
                   all(value is True for key, value in checks.items() if key != 'targetDisplayObserved') and display_matches is not False
        return {**result, 'verified': verified, 'partial': not verified, 'automationOverridden': stable and overridden,
                'verification': checks, 'observed': view,
                'limitation': 'One native value write, then bounded observation. Does not edit or recover envelopes, prove audible behavior or establish an exclusive manual-control lease. Partial work remains without rollback or replay.'}
    except Exception as error:
        return {**result, 'observationError': (str(error) or error.__class__.__name__)[:600]}


def apply(song, params, version):
    return complete(song, begin(song, params, version), version + 1)
