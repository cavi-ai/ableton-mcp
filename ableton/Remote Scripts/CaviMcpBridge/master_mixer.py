"""Bind Main mixer and hardware-output edits to their native context."""
import copy
import math
import uuid
try:
    from . import track_mixer,track_arming,sidechain_routing,crossfader
    from .clip_mute import _flag
    from .bridge import _set_mixer,_master_output_routing,_routing_option,_undo_step
except ImportError:
    import track_mixer,track_arming,sidechain_routing,crossfader
    from clip_mute import _flag
    from bridge import _set_mixer,_master_output_routing,_routing_option,_undo_step

CONTROLS = {'volume':'volume','pan':'panning','cueVolume':'cue_volume','crossfader':'crossfader'}
_identity = None


def _fields(params):
    fields = params.get('fields')
    if not isinstance(fields,list) or not 1 <= len(fields) <= 5 or any(not isinstance(key,str) for key in fields) or \
            len(set(fields)) != len(fields) or not set(fields).issubset((*CONTROLS,'outputChannelId')):
        raise ValueError('explicit Main mixer fields required')
    return sorted(fields)


def context(song, params, version):
    global _identity
    fields = _fields(params)
    initial = track_arming._inspect(song,'master')
    owner = song.master_track;mixer = owner.mixer_device
    parameters = tuple(getattr(mixer,attribute,None) for attribute in CONTROLS.values())
    controls = {field:track_mixer._parameter(parameter) for field,parameter in zip(CONTROLS,parameters)}
    main = _set_mixer(song,version)['master']
    choices = tuple(owner.available_output_routing_channels) if main['outputRouting']['supported'] else ()
    if len(choices) > 512:raise ValueError('Main output supports at most 512 channel choices')
    paths = sidechain_routing._paths(song,version)
    tracks,returns = tuple(song.tracks),tuple(song.return_tracks)
    mixers = tuple(track.mixer_device for track in (*tracks,*returns))
    switches = [{'trackId':prefix+str(index),'mute':_flag(track,'mute'),'solo':_flag(track,'solo'),
                 'crossfadeAssignment':crossfader._assignment(track.mixer_device)}
                for prefix,owners in [('track-',tracks),('return-',returns)] for index,track in enumerate(owners)]
    final = track_arming._inspect(song,'master')
    if initial[0] != final[0] or song.master_track != owner or owner.mixer_device != mixer or \
            tuple(getattr(mixer,attribute,None) for attribute in CONTROLS.values()) != parameters:
        raise ValueError('Main mixer identity or topology changed during inspection')
    if {field:track_mixer._parameter(parameter) for field,parameter in zip(CONTROLS,parameters)} != controls or \
            _master_output_routing(owner) != main['outputRouting']:
        raise ValueError('Main mixer controls or output changed during inspection')
    binding = song,final[0],owner,mixer,parameters,returns,mixers,choices
    if _identity is None or _identity[0] != binding:_identity = binding,str(uuid.uuid4())
    flags = {key:_flag(song,attribute) for key,attribute in (
        ('playing','is_playing'),('arrangementRecord','record_mode'),('sessionRecord','session_record'),('countingIn','is_counting_in'))}
    result = {'stateVersion':version,'identityToken':_identity[1],'fields':fields,'master':main,'controls':controls,
              'audioPaths':paths,'switches':switches,'armStates':final[1],'transport':flags,
              'recordingOff':flags['playing'] is not None and all(value is False for key,value in flags.items() if key != 'playing') and all(value is False for value in final[2]),
              'launchesClear':all(value is False for value in final[3]),'inspectedSlotAndClipCount':final[4]}
    changes = {field:({'previous':main['outputRouting']['channel'],'value':main['outputRouting']['channel']} if field == 'outputChannelId' else
                     {'previousValue':controls[field]['value'] if controls[field] else None,'value':controls[field]['value'] if controls[field] else None}) for field in fields}
    try:_safe(result,changes);result.update(readyToChange=True,reasons=[])
    except Exception as error:result.update(readyToChange=False,reasons=[str(error) or error.__class__.__name__])
    return result


def _safe(before, changes):
    if not before['recordingOff'] or not before['launchesClear']:raise ValueError('Main mixer changes require known inactive recording, count-in and pending launches')
    for field,change in changes.items():
        if not isinstance(change,dict):raise ValueError('explicit Main mixer change required')
        if field == 'outputChannelId':
            routing = before['master']['outputRouting'];value = change.get('value')
            matches = [row for row in routing['availableChannels'] if isinstance(value,dict) and row['id'] == value.get('id')]
            if not routing['supported'] or change.get('previous') != routing['channel'] or len(matches) != 1 or matches[0] != value:
                raise ValueError('Main output channel is unavailable or ambiguous')
            continue
        parameter = before['controls'][field]
        if parameter is None or parameter['enabled'] is not True or parameter['quantized'] is not False or parameter['automationState'] != {'value':0,'name':'none'}:
            raise ValueError('Main mixer control must be enabled and continuous with known inactive automation')
        value = change.get('value')
        if change.get('previousValue') != parameter['value'] or type(value) not in (int,float) or not math.isfinite(value) or not parameter['min'] <= value <= parameter['max']:
            raise ValueError('Main mixer value must be finite and within native bounds')
        if field == 'pan' and before['master']['pan']['panningMode'] != {'supported':True,'value':0,'name':'stereo'}:
            raise ValueError('single-pan edits require known Stereo mode')
        if field == 'crossfader' and any(row['crossfadeAssignment'].get('name') not in ('A','none','B') for row in before['switches']):
            raise ValueError('Main crossfader assignments must be known')


def _value(before, field):
    return before['master']['outputRouting']['channel'] if field == 'outputChannelId' else before['controls'][field]['value']


def _matches(actual, value):return actual == value if isinstance(value,dict) else track_mixer._near(actual,value)


def _target(owner, field, value):
    if field != 'outputChannelId':return getattr(owner.mixer_device,CONTROLS[field]),'value',value
    attribute = 'output_routing_channel' if hasattr(owner,'output_routing_channel') else 'current_output_sub_routing'
    choices = [option for option in owner.available_output_routing_channels if _routing_option(option) == value]
    if len(choices) != 1:raise ValueError('native Main output channel changed')
    if attribute == 'current_output_sub_routing':
        if sum(_routing_option(option)['name'] == value['name'] for option in owner.available_output_routing_channels) != 1:
            raise ValueError('legacy Main output channel name is ambiguous')
        return owner,attribute,value['name']
    return owner,attribute,choices[0]


def _advance(before, after, field, value):
    expected = copy.deepcopy(before)
    if field == 'outputChannelId':
        expected['master']['outputRouting']['channel'] = value
        next(row for row in expected['audioPaths'] if row['trackId'] == 'master')['output'] = value
    else:
        actual = _value(after,field)
        expected['controls'][field]['value'] = actual if _matches(actual,value) else value
        expected['master'][field]['value'] = expected['controls'][field]['value']
        if field == 'volume':
            for key in ('displayValue','decibels'):expected['master'][field][key] = after['master'][field][key]
    return expected


def begin(song, params, version):
    changes = params.get('changes')
    if not isinstance(changes,dict) or not changes or not set(changes).issubset((*CONTROLS,'outputChannelId')):
        raise ValueError('at least one valid Main mixer change required')
    query = {'fields':sorted(changes)}
    if type(params.get('expectedStateVersion')) is not int or not isinstance(params.get('before'),dict):raise ValueError('native Main mixer context and state version required')
    before = context(song,query,version)
    if params['expectedStateVersion'] != version or before != params['before']:raise ValueError('native Main mixer identity or context changed after planning')
    _safe(before,changes)
    operation = {'song':song,'params':params,'query':query,'before':before,'expected':before,'writes':[],'error':None}
    if all(_matches(_value(before,field),change['value']) for field,change in changes.items()):return operation
    def priority(item):
        field,change = item
        if field == 'volume':return 0 if change['value'] < _value(before,field) else 3
        return 1 if field == 'outputChannelId' else 2
    try:
        with _undo_step(song):
            for field,change in sorted(changes.items(),key=priority):
                current = context(song,query,version)
                if current != operation['expected']:raise ValueError('native Main mixer context changed before write')
                if _matches(_value(current,field),change['value']):continue
                owner = song.master_track
                target,attribute,value = _target(owner,field,change['value'])
                if song.master_track != owner or context(song,query,version) != operation['expected']:
                    raise ValueError('native Main mixer context changed during control resolution')
                write = {'field':field,'value':change['value'],'writeRequested':True,'nativeReturned':False}
                operation['writes'].append(write)
                setattr(target,attribute,value);write['nativeReturned'] = True
                after = context(song,query,version)
                operation['expected'] = _advance(current,after,field,change['value'])
                if after != operation['expected']:raise ValueError('Main mixer readback or unrequested context changed after write')
    except Exception as error:
        if not operation['writes']:raise
        operation['error'] = (str(error) or error.__class__.__name__)[:600]
    return operation


def unobserved(operation, version, error):
    return {'stateVersion':version,'master':None,'returns':None,'writes':operation['writes'],
            'writeRequested':bool(operation['writes']),'nativeReturned':bool(operation['writes']) and all(row['nativeReturned'] for row in operation['writes']),
            'verified':False,'targetRetained':False,'contextPreserved':False,'requestedChangesVerified':False,
            'observedContext':None,'error':operation['error'],'observationError':None if error is None else (str(error) or error.__class__.__name__)[:600],
            'verification':{'topologyStable':False,'recordingOff':False},
            'limitation':'Exposed Main controls, selected routes and crossfader membership only; not a timed fade, isolated mix or audible-output verification. Writes are not atomic. Partial changes remain without rollback or replay.'}


def complete(song, operation, version):
    result = unobserved(operation,version,None)
    try:
        returns = _set_mixer(song,version)['returns']
        after = context(song,operation['query'],version)
        expected = copy.deepcopy(operation['expected']);expected['stateVersion'] = version
        retained = song == operation['song'] and after['identityToken'] == operation['before']['identityToken']
        matched = all(_matches(_value(after,field),change['value']) for field,change in operation['params']['changes'].items())
        result.update(master=after['master'],returns=returns,observedContext=after,
                      targetRetained=retained,contextPreserved=retained and expected == after,requestedChangesVerified=retained and matched,
                      verification={'topologyStable':retained,'recordingOff':after['recordingOff'] and after['launchesClear']})
        result['verified'] = result['contextPreserved'] and result['requestedChangesVerified'] and result['error'] is None
        if not result['verified'] and result['error'] is None:result['error'] = 'native Main mixer readback or unrequested context did not match the plan'
    except Exception as error:result['observationError'] = (str(error) or error.__class__.__name__)[:600]
    return result


def apply(song, params, version):return complete(song,begin(song,params,version),version+1)
