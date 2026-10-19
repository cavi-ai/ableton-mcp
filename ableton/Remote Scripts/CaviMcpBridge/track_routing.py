"""Confirm exact native routing choices and retain partial write outcomes."""
import copy
try:
    from . import track_arming
    from .bridge import _track, _track_routing, _routing_option, _undo_step
except ImportError:
    import track_arming
    from bridge import _track, _track_routing, _routing_option, _undo_step


FIELDS = {
    'inputTypeId': ('input', 'type', 'input_routing_type', 'current_input_routing', 'available_input_routing_types'),
    'inputChannelId': ('input', 'channel', 'input_routing_channel', 'current_input_sub_routing', 'available_input_routing_channels'),
    'outputTypeId': ('output', 'type', 'output_routing_type', 'current_output_routing', 'available_output_routing_types'),
    'outputChannelId': ('output', 'channel', 'output_routing_channel', 'current_output_sub_routing', 'available_output_routing_channels'),
}
ORDER = tuple(FIELDS) + ('monitoring',)


def context(song, params, version):
    arm = track_arming.context(song, params, version)
    routing = _track_routing(song, params['trackId'], version)
    inputs = arm['inputStates']
    index = int(params['trackId'][6:])
    # Normalize legacy display strings to the same exact choices used by routing.
    inputs[index] = {'trackId':params['trackId'], 'inputType':routing['input']['type'],
                     'inputChannel':routing['input']['channel'],
                     'monitoring':None if routing['monitoring'] is None else routing['monitoring']['value']}
    return {**routing, 'identityToken':arm['identityToken'],
            'target':{key:arm['target'][key] for key in ('isGroup','isFrozen')},
            'armStates':arm['armStates'], 'inputStates':inputs, 'transport':arm['transport'],
            'recordingOff':'recording_or_count_in_active_or_unknown' not in arm['reasons'],
            'launchesClear':'pending_launch_or_unknown' not in arm['reasons'],
            'inspectedSlotAndClipCount':arm['inspectedSlotAndClipCount']}


def _value(snapshot, key):
    if key == 'monitoring':
        return None if snapshot[key] is None else {k:snapshot[key][k] for k in ('value','name')}
    section, field = FIELDS[key][:2]
    return snapshot[section][field]


def _selected(snapshot, key, value):
    if key == 'monitoring':
        if snapshot[key] is None:
            raise ValueError('monitoring is not supported on Group Tracks')
        if not isinstance(value, dict) or type(value.get('value')) is not int:
            raise ValueError('explicit native monitoring value required')
        choices = snapshot[key]['choices']
        matches = [row for row in choices if row['value'] == value['value']]
    else:
        if not isinstance(value, dict) or not isinstance(value.get('id'), str):
            raise ValueError('exact routing identifier required')
        section, field = FIELDS[key][:2]
        matches = [row for row in snapshot[section]['availableTypes' if field == 'type' else 'availableChannels'] if row['id'] == value['id']]
    if len(matches) != 1 or matches[0] != value:
        raise ValueError('routing choice changed or is ambiguous: '+key)
    return matches[0]


def _check_ready(before, changes):
    if not before['recordingOff'] or not before['launchesClear']:
        raise ValueError('routing requires known inactive recording, count-in and pending launches')
    if any(key.startswith('input') or key == 'monitoring' for key in changes):
        if before['target']['isGroup'] is not False:
            raise ValueError('input and monitoring changes are not supported on Group Tracks')
        row = before['armStates'][int(before['trackId'][6:])]
        if before['target']['isFrozen'] is not False or row['armed'] is not False or row['implicitArm'] is not False:
            raise ValueError('input and monitoring changes require a known unfrozen, disarmed target')


def _advance(before, after, key, value, dependent):
    """Permit only the requested control and its native dependent channel."""
    expected = copy.deepcopy(before)
    index = int(before['trackId'][6:])
    if key == 'monitoring':
        expected[key].update(value)
        expected['inputStates'][index]['monitoring'] = value['value']
    else:
        section, field = FIELDS[key][:2]
        expected[section][field] = value
        if section == 'input':
            expected['inputStates'][index]['inputType' if field == 'type' else 'inputChannel'] = value
        if field == 'type':
            expected[section]['channel'] = after[section]['channel']
            expected[section]['availableChannels'] = after[section]['availableChannels']
            if before[section]['channel'] != after[section]['channel']:
                dependent.append({'field':section+'ChannelId', 'previous':before[section]['channel'], 'value':after[section]['channel']})
            if section == 'input':
                expected['inputStates'][index]['inputChannel'] = after[section]['channel']
                expected['armStates'][index]['canBeArmed'] = after['armStates'][index]['canBeArmed']
    return expected


def begin(song, params, version):
    changes = params.get('changes')
    if not isinstance(changes, dict) or not changes or not set(changes).issubset(ORDER):
        raise ValueError('at least one valid routing change is required')
    if type(params.get('expectedStateVersion')) is not int or not isinstance(params.get('before'), dict):
        raise ValueError('native routing context and state version required')
    before = context(song, params, version)
    if params['expectedStateVersion'] != version or params['before'] != before:
        raise ValueError('native routing context changed after planning')
    _check_ready(before, changes)
    values = {}
    for key in ORDER:
        if key not in changes: continue
        change = changes[key]
        if not isinstance(change, dict) or change.get('previous') != _value(before, key):
            raise ValueError('previous routing value changed: '+key)
        values[key] = _selected(before, key, change.get('value'))
    operation = {'song':song,'params':params,'before':before,'expected':before,
                 'writes':[], 'dependentChannelChanges':[], 'error':None}
    if all(_value(before,key) == value for key,value in values.items()):
        return operation
    try:
        with _undo_step(song):
            for key,value in values.items():
                current = context(song, params, version)
                if current != operation['expected']:
                    raise ValueError('native routing context changed before write: '+key)
                _check_ready(current, {key:value})
                _selected(current,key,value)
                if _value(current,key) == value: continue
                track = _track(song, params['trackId'])[1]
                if key == 'monitoring':
                    attribute, native = 'current_monitoring_state', value['value']
                else:
                    _,_,modern,legacy,available = FIELDS[key]
                    options = [option for option in getattr(track,available) if _routing_option(option) == value]
                    if len(options) != 1: raise ValueError('native routing option changed: '+key)
                    attribute = modern if hasattr(track,modern) else legacy
                    native = options[0] if attribute == modern else value['name']
                    if attribute == legacy and sum(_routing_option(option)['name'] == value['name'] for option in getattr(track,available)) != 1:
                        raise ValueError('ambiguous legacy routing label: '+key)
                if context(song,params,version) != operation['expected'] or _track(song,params['trackId'])[1] != track:
                    raise ValueError('native routing context changed during option resolution: '+key)
                write = {'field':key,'value':value,'writeRequested':True,'nativeReturned':False}
                operation['writes'].append(write)
                setattr(track,attribute,native)
                write['nativeReturned'] = True
                after = context(song,params,version)
                operation['expected'] = _advance(current,after,key,value,operation['dependentChannelChanges'])
                if after != operation['expected']:
                    raise ValueError('routing readback or unrequested context changed after write: '+key)
    except Exception as error:
        if not operation['writes']: raise
        operation['error'] = (str(error) or error.__class__.__name__)[:600]
    return operation


def unobserved(operation, version, error):
    return {'stateVersion':version,'trackId':operation['params']['trackId'],
            'input':None,'output':None,'monitoring':None,
            'writes':operation['writes'],'writeRequested':bool(operation['writes']),
            'nativeReturned':bool(operation['writes']) and all(row['nativeReturned'] for row in operation['writes']),
            'verified':False,'targetRetained':False,'contextPreserved':False,
            'requestedChangesVerified':False,'observedContext':None,
            'dependentChannelChanges':operation['dependentChannelChanges'],
            'error':operation['error'],'observationError':None if error is None else (str(error) or error.__class__.__name__)[:600],
            'verification':{'topologyStable':False,'recordingOff':False},
            'limitation':'Exposed routing controls only, not signal or audible-output proof. Type changes can reset channels; inspect the resulting choices before changing a channel. Partial changes remain without rollback or replay.'}


def complete(song, operation, version):
    result = unobserved(operation,version,None)
    try:
        observed = context(song,operation['params'],version)
        expected = copy.deepcopy(operation['expected'])
        expected['stateVersion'] = version
        retained = song == operation['song'] and observed['identityToken'] == operation['before']['identityToken']
        matched = all(_value(observed,key) == change['value'] for key,change in operation['params']['changes'].items())
        result.update({key:observed[key] for key in ('input','output','monitoring')})
        result.update(targetRetained=retained,contextPreserved=retained and observed == expected,
                      requestedChangesVerified=retained and matched,observedContext=observed,
                      verification={'topologyStable':retained,'recordingOff':observed['recordingOff'] and observed['launchesClear']})
        result['verified'] = result['contextPreserved'] and result['requestedChangesVerified'] and result['error'] is None
        if not result['verified'] and result['error'] is None:
            result['error'] = 'native routing readback or unrequested context did not match the plan'
    except Exception as error:
        result['observationError'] = (str(error) or error.__class__.__name__)[:600]
    return result


def apply(song, params, version):
    return complete(song,begin(song,params,version),version+1)
