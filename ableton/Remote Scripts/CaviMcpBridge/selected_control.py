"""Resolve Live's selected parameter and guard one explicit value edit."""
import math
try:
    from . import parameter_automation as automation, parameter_display as displays
    from .bridge import _set_fingerprint, _undo_step
except ImportError:
    import parameter_automation as automation
    import parameter_display as displays
    from bridge import _set_fingerprint, _undo_step


def _index(items, selected, limit):
    items = tuple(items)
    if len(items) > limit: raise ValueError('selected-control ancestry exceeds bounded native layout')
    matches = [index for index, item in enumerate(items) if item == selected]
    if len(matches) != 1: raise ValueError('native selected control has unresolved or ambiguous membership')
    return matches[0]


def _owners(song):
    tracks, returns = tuple(song.tracks), tuple(song.return_tracks)
    if len(tracks) > 256 or len(returns) > 64: raise ValueError('selected-control lookup supports 256 tracks and 64 Returns')
    return [(f'track-{i}', owner) for i, owner in enumerate(tracks)] + \
           [(f'return-{i}', owner) for i, owner in enumerate(returns)] + [('master', song.master_track)]


def _target(song, selected, owners):
    parent = selected.canonical_parent
    current, owner_id, owner = parent, None, None
    for _ in range(35):
        matches = [(key, candidate) for key, candidate in owners if candidate == current]
        if len(matches) == 1:
            owner_id, owner = matches[0]
            break
        if len(matches) > 1: raise ValueError('selected parameter owner is ambiguous')
        current = getattr(current, 'canonical_parent', None)
        if current is None: break
    if owner is None: raise ValueError('selected parameter has no supported canonical track owner')
    if parent == owner.mixer_device:
        _, _, rows, _ = automation._objects(song, {'trackId': owner_id})
        matches = [key for key, parameter, _ in rows if parameter is not None and parameter == selected]
        if len(matches) != 1: raise ValueError('selected mixer control is not uniquely exposed')
        return {'trackId': owner_id, 'parameterId': matches[0]}
    parts, device = [], parent
    for _ in range(17):
        container = device.canonical_parent
        index = _index(container.devices, device, 4096)
        parts.insert(0, f'device-{index}')
        if container == owner:
            parameter_id = _index(parent.parameters, selected, 2048)
            return {'trackId': owner_id, 'deviceId': owner_id + ':' + '/'.join(parts), 'parameterId': f'parameter-{parameter_id}'}
        rack = container.canonical_parent
        matches = []
        for kind, chains in [('chain', getattr(rack, 'chains', ())), ('return-chain', getattr(rack, 'return_chains', ()))]:
            chains = tuple(chains)
            if len(chains) > 512: raise ValueError('selected-control rack exceeds 512 chains')
            matches += [(kind, i) for i, chain in enumerate(chains) if chain == container]
        if len(matches) != 1: raise ValueError('selected parameter chain is unresolved or ambiguous')
        kind, index = matches[0]
        parts.insert(0, f'{kind}-{index}')
        device = rack
    raise ValueError('selected parameter exceeds 16 rack levels')


def _flag(owner, name):
    try: value = getattr(owner, name, None)
    except Exception: return None
    return bool(value) if type(value) in (int, bool) and value in (0, 1) else None


def _flags(song, owner, track_id):
    return {'frozen': _flag(owner, 'is_frozen') if track_id.startswith('track-') else False,
            'arrangementRecord': _flag(song, 'record_mode'), 'sessionRecord': _flag(song, 'session_record'),
            'countingIn': _flag(song, 'is_counting_in')}


def context(song, version):
    base = {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'selectionToken': None,
            'target': None, 'control': None, 'automationContext': None, 'editContext': None}
    try: selected = song.view.selected_parameter
    except Exception: return {**base, 'status': 'unavailable'}
    if selected is None or type(selected) is int and selected == 0: return {**base, 'status': 'none'}
    owners = _owners(song)
    try: target = _target(song, selected, owners)
    except Exception as error:
        return {**base, 'status': 'unresolved', 'reason': str(error)[:240]}
    owner, _, rows, binding = automation._objects(song, target)
    if rows[0][1] != selected: raise ValueError('selected parameter changed during resolution')
    view = automation.context(song, target, version)
    control = view['controls'][0]
    items = tuple(getattr(selected, 'value_items', ())) if control.get('quantized') is True else ()
    if len(items) > 2048: raise ValueError('selected parameter exceeds 2048 choice labels')
    choices = None
    if control.get('supported') and control.get('quantized') is True:
        low, high = control['min'], control['max']
        if float(low).is_integer() and float(high).is_integer() and 0 <= high - low <= 31:
            try: choices = [{'value': value, 'displayValue': selected.str_for_value(value)} for value in range(int(low), int(high) + 1)]
            except Exception: choices = None
    if (song.view.selected_parameter != selected or _owners(song) != owners
            or _target(song, selected, owners) != target or automation._objects(song, target)[3] != binding):
        raise ValueError('selected parameter or native ancestry changed during read')
    return {**base, 'status': 'selected', 'selectionToken': view['identityToken'], 'target': target,
            'control': {**control, 'valueItems': list(items), 'nativeChoiceLabels': choices}, 'automationContext': view,
            'editContext': _flags(song, owner, target['trackId'])}


def _safe(selection):
    if selection['status'] != 'selected': raise ValueError('a uniquely resolved selected parameter is required')
    p, view = selection['control'], selection['automationContext']
    if (p.get('supported') is not True or p.get('enabled') is not True or type(p.get('quantized')) is not bool
            or p.get('automationState') not in ({'value': 0, 'name': 'none'}, {'value': 2, 'name': 'overridden'})):
        raise ValueError('selected control must be enabled with known inactive or already overridden automation')
    if any(value is not False for value in selection['editContext'].values()):
        raise ValueError('resolve recording, count-in and frozen state before editing the selected control')
    target = selection['target']
    if ('deviceId' not in target and target['parameterId'] in ('pan', 'left', 'right')
            and view['panningMode'] != (0 if target['parameterId'] == 'pan' else 1)):
        raise ValueError('selected pan control does not match the active native panning mode')


def prepare(song, params, version):
    selection = context(song, version)
    _safe(selection)
    if params.get('expectedSelectionToken') != selection['selectionToken']:
        raise ValueError('selected parameter changed; read the current selection')
    _, _, rows, binding = automation._objects(song, selection['target'])
    parameter, control = rows[0][1], selection['control']
    raw, display = params.get('value'), params.get('targetDisplay')
    if (raw is not None) == (display is not None): raise ValueError('provide exactly one value or targetDisplay')
    if display is not None:
        if control['quantized']: raise ValueError('unit displays require a continuous selected control')
        target = displays._target(parameter, displays._quantity(display))
    else:
        if type(raw) not in (int, float) or not math.isfinite(raw) or not control['min'] <= raw <= control['max']:
            raise ValueError('finite value within native bounds required; no clamping')
        if control['quantized'] and raw != int(raw): raise ValueError('quantized control requires an integer')
        target = {'value': raw, 'displayValue': parameter.str_for_value(raw)}
    if context(song, version) != selection or automation._objects(song, selection['target'])[3] != binding:
        raise ValueError('selected control changed during target resolution')
    return {'selection': selection, 'target': target}


def apply(song, params, version):
    source = prepare(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or source != params.get('before'):
        raise ValueError('selected control, target or value changed after planning')
    selection, target = source['selection'], source['target']
    owner, _, rows, binding = automation._objects(song, selection['target'])
    attempted, returned, error = False, False, None
    try:
        with _undo_step(song):
            if prepare(song, params, version) != source or automation._objects(song, selection['target'])[3] != binding:
                raise ValueError('selected control changed before value write')
            attempted = True
            try:
                rows[0][1].value = target['value']
                returned = True
            except Exception as failure: error = str(failure)[:600]
    except Exception as failure:
        if not attempted: raise
        error = f'{error}; finalization: {failure}' if error else f'finalization: {failure}'
    result = {'stateVersion': version + 1, 'valueWriteRequested': attempted, 'nativeReturned': returned,
              'verified': False, 'selectionPreserved': None, 'error': error, 'observed': None, 'selection': None}
    try:
        observed = automation.context(song, selection['target'], version + 1)
        current = context(song, version + 1)
        p = observed['controls'][0]
        same_selection = current['target'] == selection['target'] and current['selectionToken'] == selection['selectionToken']
        display_matches = None
        if 'quantity' in target:
            try: display_matches = displays._equal(displays._quantity(p.get('displayValue')), target['quantity'])
            except Exception: display_matches = False
        checks = {'targetIdentityPreserved': automation._objects(song, selection['target'])[3] == binding,
                  'valueObserved': p.get('supported') is True and abs(p['value'] - target['value']) <= 1e-6,
                  'displayObserved': display_matches, 'selectionPreserved': same_selection,
                  'automationPreserved': p.get('automationState') == selection['control']['automationState'],
                  'editContextPreserved': _flags(song, owner, selection['target']['trackId']) == selection['editContext'],
                  'controlMetadataPreserved': automation._metadata(observed) == automation._metadata(selection['automationContext'])}
        verified = returned and error is None and all(v is True for key, v in checks.items() if key != 'displayObserved') and display_matches is not False
        return {**result, 'verified': verified, 'selectionPreserved': same_selection, 'verification': checks,
                'observed': observed, 'selection': current, 'error': error if verified or error else 'selected-control readback did not match the confirmed plan'}
    except Exception as failure:
        return {**result, 'observationError': str(failure)[:600]}
