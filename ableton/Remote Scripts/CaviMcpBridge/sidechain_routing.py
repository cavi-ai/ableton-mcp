"""Bind one detector route to its native device and unchanged audio paths."""
import copy
import uuid
try:
    from . import parameter_automation, track_arming
    from .clip_mute import _flag
    from .bridge import _device_sidechain_routing, _track_routing, _return_routing, _routing_option, _undo_step
except ImportError:
    import parameter_automation, track_arming
    from clip_mute import _flag
    from bridge import _device_sidechain_routing, _track_routing, _return_routing, _routing_option, _undo_step

_song = None
_identities = {}


def _paths(song, version):
    result = []
    for index, _ in enumerate(song.tracks):
        row = _track_routing(song,'track-'+str(index),version)
        for section in ('input','output'):
            if any(len(row[section][key]) > 512 for key in ('availableTypes','availableChannels')):
                raise ValueError('routing inspection supports at most 512 choices per field')
        result.append({'trackId':row['trackId'],
                       **{section:{key:row[section][key] for key in ('type','channel')} for section in ('input','output')},
                       'monitoring':None if row['monitoring'] is None else row['monitoring']['value']})
    for index, _ in enumerate(song.return_tracks):
        row = _return_routing(song,'return-'+str(index),version)
        result.append({'trackId':row['returnTrackId'],'output':{key:row['output'][key] for key in ('supported','type','channel')}})
    master = song.master_track
    attribute = 'output_routing_channel' if hasattr(master,'output_routing_channel') else 'current_output_sub_routing'
    result.append({'trackId':'master','output':_routing_option(getattr(master,attribute)) if hasattr(master,attribute) else None})
    return result


def context(song, params, version):
    global _song
    owner,device,_,binding = parameter_automation._objects(song,params)
    inspection = track_arming._inspect(song,params['trackId'])
    native = _device_sidechain_routing(song,params['trackId'],params['deviceId'],version)
    if any(len(native['sidechain'][key]) > 512 for key in ('availableTypes','availableChannels')):
        raise ValueError('sidechain routing supports at most 512 choices per field')
    paths = _paths(song,version)
    final = track_arming._inspect(song,params['trackId'])
    if inspection[0] != final[0] or parameter_automation._objects(song,params)[3] != binding:
        raise ValueError('native sidechain owner or track layout changed during inspection')
    identity = binding, final[0], tuple(song.return_tracks), song.master_track
    if _song != song:
        _song = song
        _identities.clear()
    key = params['trackId'],params['deviceId']
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if len(_identities) >= 128: _identities.pop(next(iter(_identities)))
        cached = identity,str(uuid.uuid4())
        _identities[key] = cached
    flags = {key:_flag(song,attribute) for key,attribute in (
        ('playing','is_playing'),('arrangementRecord','record_mode'),('sessionRecord','session_record'),('countingIn','is_counting_in'))}
    return {**native,'identityToken':cached[1], 'audioPaths':paths,'armStates':final[1],
            'frozen':_flag(owner,'is_frozen') if params['trackId'].startswith('track-') else False,
            'transport':flags,'recordingOff':flags['playing'] is not None and
                all(value is False for key,value in flags.items() if key != 'playing') and all(value is False for value in final[2]),
            'launchesClear':all(value is False for value in final[3]),'inspectedSlotAndClipCount':final[4]}


def _safe(before):
    if not before['sidechain']['supported']: raise ValueError('device sidechain routing is unsupported')
    if before['frozen'] is not False or not before['recordingOff'] or not before['launchesClear']:
        raise ValueError('sidechain routing requires known inactive recording, count-in and pending launches and an unfrozen owner')


def begin(song, params, version):
    changes = params.get('changes')
    if not isinstance(changes,dict) or len(changes) != 1 or not set(changes).issubset(('sourceTypeId','sourceChannelId')):
        raise ValueError('exactly one sidechain routing change is required')
    if type(params.get('expectedStateVersion')) is not int or not isinstance(params.get('before'),dict):
        raise ValueError('native sidechain context and state version required')
    before = context(song,params,version)
    if params['expectedStateVersion'] != version or before != params['before']:
        raise ValueError('native sidechain identity or context changed after planning')
    _safe(before)
    key = next(iter(changes))
    field,available,attribute = ('type','availableTypes','input_routing_type') if key == 'sourceTypeId' else ('channel','availableChannels','input_routing_channel')
    change = changes[key]
    if not isinstance(change,dict) or change.get('previous') != before['sidechain'][field]:
        raise ValueError('previous sidechain routing value changed')
    value = change.get('value')
    if not isinstance(value,dict) or not isinstance(value.get('id'),str): raise ValueError('exact sidechain routing choice required')
    matches = [row for row in before['sidechain'][available] if row['id'] == value['id']]
    if len(matches) != 1 or matches[0] != value: raise ValueError('unknown or ambiguous sidechain routing choice')
    operation = {'song':song,'params':params,'before':before,'field':field,'value':value,
                 'writeRequested':False,'nativeReturned':False,'error':None}
    if value == before['sidechain'][field]: return operation
    try:
        with _undo_step(song):
            if context(song,params,version) != before: raise ValueError('native sidechain context changed at undo entry')
            owner,device,_,binding = parameter_automation._objects(song,params)
            choices = device.available_input_routing_types if field == 'type' else device.available_input_routing_channels
            options = [option for option in choices if _routing_option(option) == value]
            if len(options) != 1: raise ValueError('native sidechain choice changed')
            if context(song,params,version) != before or parameter_automation._objects(song,params)[3] != binding:
                raise ValueError('native sidechain context changed during option resolution')
            operation['writeRequested'] = True
            setattr(device,attribute,options[0])
            operation['nativeReturned'] = True
    except Exception as error:
        if not operation['writeRequested']: raise
        operation['error'] = (str(error) or error.__class__.__name__)[:600]
    return operation


def unobserved(operation, version, error):
    return {'stateVersion':version,**{key:operation['params'][key] for key in ('trackId','deviceId')},
            'device':None,'sidechain':None,'writeRequested':operation['writeRequested'],
            'nativeReturned':operation['nativeReturned'],'verified':False,'targetRetained':False,
            'contextPreserved':False,'requestedChangeVerified':False,'channelChanged':None,
            'observedContext':None,'error':operation['error'],
            'observationError':None if error is None else (str(error) or error.__class__.__name__)[:600],
            'verification':{'topologyStable':False,'recordingOff':False},
            'limitation':'Exposed detector routing and selected audio paths only, not detector enable, gain reduction, signal or audible ducking proof. Source types can reset the tap; inspect refreshed channels. Partial changes remain without rollback or replay.'}


def complete(song, operation, version):
    result = unobserved(operation,version,None)
    try:
        after = context(song,operation['params'],version)
        before = operation['before']
        expected = copy.deepcopy(before)
        expected['stateVersion'] = version
        expected['sidechain'][operation['field']] = operation['value']
        if operation['field'] == 'type' and operation['writeRequested']:
            expected['sidechain']['channel'] = after['sidechain']['channel']
            expected['sidechain']['availableChannels'] = after['sidechain']['availableChannels']
        retained = song == operation['song'] and after['identityToken'] == before['identityToken']
        result.update(device=after['device'],sidechain=after['sidechain'],observedContext=after,
                      targetRetained=retained,contextPreserved=retained and expected == after,
                      requestedChangeVerified=retained and after['sidechain'][operation['field']] == operation['value'],
                      channelChanged=after['sidechain']['channel'] != before['sidechain']['channel'],
                      verification={'topologyStable':retained,'recordingOff':after['recordingOff'] and after['launchesClear']})
        result['verified'] = result['contextPreserved'] and result['requestedChangeVerified'] and result['error'] is None and (
            not result['writeRequested'] or result['nativeReturned'])
        if not result['verified'] and result['error'] is None: result['error'] = 'native sidechain readback or unrequested context did not match the plan'
    except Exception as error:
        result['observationError'] = (str(error) or error.__class__.__name__)[:600]
    return result


def apply(song, params, version):
    return complete(song,begin(song,params,version),version+1)
