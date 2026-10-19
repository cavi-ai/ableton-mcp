"""Observe and confirm single or multi-track mixer changes without replay."""
import copy
import math
import re
import uuid
try:
    from . import track_arming,sidechain_routing,panning
    from .clip_mute import _flag
    from .bridge import _device_owner,_return_mixer_record,_parameter_automation_state,_undo_step,dispatch_request
except ImportError:
    import track_arming,sidechain_routing,panning
    from clip_mute import _flag
    from bridge import _device_owner,_return_mixer_record,_parameter_automation_state,_undo_step,dispatch_request

_song = None
_identities = {}


def _parameter(parameter):
    if parameter is None:return None
    value,low,high = float(parameter.value),float(parameter.min),float(parameter.max)
    if not all(math.isfinite(number) for number in (value,low,high)) or not low <= value <= high or low >= high:
        raise ValueError('native mixer value or bounds are invalid')
    return {'value':value,'min':low,'max':high,
            'enabled':_flag(parameter,'is_enabled'),'quantized':_flag(parameter,'is_quantized'),
            'automationState':_parameter_automation_state(parameter)}


def _control(track, field):
    mixer = track.mixer_device
    if field == 'mute':return getattr(mixer,'track_activator',None)
    if field == 'solo':return None
    if field.startswith('send-'):
        index = int(field[5:])
        if index >= len(mixer.sends):raise ValueError('unknown send '+field)
        return mixer.sends[index]
    return getattr(mixer,'panning' if field == 'pan' else 'volume')


def context(song, params, version):
    global _song
    ids,fields = params.get('trackIds'),params.get('fields')
    if not isinstance(ids,list) or not 1 <= len(ids) <= 64 or len(set(ids)) != len(ids) or any(
            not isinstance(key,str) or not re.fullmatch(r'(?:track|return)-(?:0|[1-9][0-9]*)',key) for key in ids):
        raise ValueError('one to 64 unique canonical track or Return IDs required')
    if not isinstance(fields,list) or not fields or len(fields) > 68 or len(set(fields)) != len(fields) or any(
            not isinstance(key,str) or not re.fullmatch(r'(?:volume|pan|mute|solo|send-(?:0|[1-9][0-9]*))',key) for key in fields):
        raise ValueError('explicit mixer fields required')
    fields = sorted(fields)
    if len(song.return_tracks) > 64:raise ValueError('mixer context supports at most 64 Returns')
    inspection = track_arming._inspect(song,ids[0])
    rows,bindings = [],[]
    for track_id in ids:
        _,track = _device_owner(song,track_id)
        row = {'trackId':track_id,'name':str(track.name),'mute':_flag(track,'mute'),'solo':_flag(track,'solo'),
               'frozen':_flag(track,'is_frozen'),'controls':{},'sends':[]}
        parameters = []
        for field in fields:
            parameter = _control(track,field);parameters.append(parameter)
            row['controls'][field] = _parameter(parameter)
            if field in ('volume','pan'):
                row[field] = row['controls'][field]
                if field == 'pan':row[field] = {**row[field],'panningMode':panning.mode_record(track.mixer_device)}
            if field.startswith('send-'):
                index = int(field[5:])
                if index >= len(song.return_tracks):raise ValueError('unknown send '+field)
                row['sends'].append({'id':field,'returnTrackId':'return-'+str(index),'name':str(song.return_tracks[index].name),**row['controls'][field]})
        rows.append(row);bindings.append((track,track.mixer_device,tuple(parameters)))
    paths = sidechain_routing._paths(song,version)
    final = track_arming._inspect(song,ids[0])
    if inspection[0] != final[0]:raise ValueError('mixer topology changed during inspection')
    identity = final[0],tuple(bindings),tuple(song.return_tracks),song.master_track
    if _song != song:
        _song = song;_identities.clear()
    key = tuple(ids),tuple(fields)
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if len(_identities) >= 128:_identities.pop(next(iter(_identities)))
        cached = identity,str(uuid.uuid4());_identities[key] = cached
    flags = {key:_flag(song,attribute) for key,attribute in (
        ('playing','is_playing'),('arrangementRecord','record_mode'),('sessionRecord','session_record'),('countingIn','is_counting_in'))}
    switches = [{'trackId':prefix+str(index),'mute':_flag(track,'mute'),'solo':_flag(track,'solo')}
                for prefix,owners in [('track-',song.tracks),('return-',song.return_tracks)] for index,track in enumerate(owners)]
    result = {'stateVersion':version,'trackIds':ids,'fields':fields,'identityToken':cached[1],'tracks':rows,
            'switches':switches,'audioPaths':paths,'armStates':final[1],'transport':flags,
            'recordingOff':flags['playing'] is not None and all(value is False for key,value in flags.items() if key != 'playing') and all(value is False for value in final[2]),
            'launchesClear':all(value is False for value in final[3]),'inspectedSlotAndClipCount':final[4]}
    try:
        checks = []
        for row in rows:
            for field in fields:
                change = {'previousValue':_value(row,field),'value':_value(row,field)}
                if field.startswith('send-'):
                    send = next(item for item in row['sends'] if item['id'] == field)
                    change.update({key:send[key] for key in ('returnTrackId','name')})
                checks.append((row['trackId'],field,change))
        _safe(result,checks)
        result.update(readyToChange=True,reasons=[])
    except Exception as error:result.update(readyToChange=False,reasons=[str(error) or error.__class__.__name__])
    return result


def _value(row, field):
    if field in ('mute','solo'):return row[field]
    return row['controls'][field]['value']


def _near(left, right):
    return type(left) is type(right) and left == right if type(right) is bool else type(left) in (int,float) and math.isfinite(left) and abs(left-right) <= 1e-6


def _flatten(params):
    tracks = params.get('tracks') if 'trackIds' in params else [{'trackId':params.get('trackId'),'changes':params.get('changes')}]
    if not isinstance(tracks,list) or not tracks:raise ValueError('explicit track mixer changes required')
    if 'trackIds' in params and [row.get('trackId') for row in tracks] != params['trackIds']:raise ValueError('bulk mixer target order changed')
    writes = []
    for row in tracks:
        changes = row.get('changes')
        if not isinstance(changes,dict) or not changes or not set(changes).issubset(('volume','pan','mute','solo','sends')):
            raise ValueError('at least one valid mixer change required')
        for field,change in changes.items():
            if field == 'sends':
                if not isinstance(change,list):raise ValueError('send changes must be an array')
                for send in change:writes.append((row['trackId'],send.get('id'),send))
            else:writes.append((row['trackId'],field,change))
    if not writes or len({(t,f) for t,f,_ in writes}) != len(writes):raise ValueError('nonempty unique mixer changes required')
    return tracks,writes


def _safe(before, writes):
    if not before['recordingOff'] or not before['launchesClear']:raise ValueError('mixer changes require known inactive recording, count-in and pending launches')
    rows = {row['trackId']:row for row in before['tracks']}
    for track_id,field,change in writes:
        row = rows[track_id]
        if not isinstance(change,dict) or change.get('previousValue') != _value(row,field):raise ValueError('previous mixer value changed')
        value = change.get('value')
        if field in ('mute','solo'):
            if type(value) is not bool or type(row[field]) is not bool:raise ValueError('explicit known boolean mixer control required')
        else:
            parameter = row['controls'][field]
            if type(value) not in (int,float) or not math.isfinite(value) or not parameter['min'] <= value <= parameter['max']:raise ValueError('mixer value must be finite and within native bounds')
        if field == 'solo':continue
        parameter = row['controls'][field]
        if parameter is None or parameter['enabled'] is not True or parameter['automationState'] != {'value':0,'name':'none'}:
            raise ValueError('mixer control must be enabled with known inactive automation')
        if field == 'mute':
            if parameter['min'] != 0 or parameter['max'] != 1 or parameter['value'] != int(not row['mute']):raise ValueError('native track activator is unresolved')
        elif parameter['quantized'] is not False:raise ValueError('continuous native mixer control required')
        if field == 'pan' and row['pan']['panningMode'] != {'supported':True,'value':0,'name':'stereo'}:raise ValueError('single-pan edits require known Stereo mode')
        if field.startswith('send-'):
            send = next(item for item in row['sends'] if item['id'] == field)
            if any(change.get(key) != send[key] for key in ('returnTrackId','name')):raise ValueError('send Return identity changed')


def _advance(before, after, track_id, field, value):
    expected = copy.deepcopy(before)
    index = before['trackIds'].index(track_id)
    row = expected['tracks'][index]
    if field in ('mute','solo'):
        row[field] = value
        next(item for item in expected['switches'] if item['trackId'] == track_id)[field] = value
        if field == 'mute':row['controls']['mute']['value'] = int(not value)
    else:
        actual = _value(after['tracks'][index],field)
        row['controls'][field]['value'] = actual if _near(actual,value) else value
        if field in ('volume','pan'):row[field]['value'] = row['controls'][field]['value']
        else:next(item for item in row['sends'] if item['id'] == field)['value'] = row['controls'][field]['value']
    return expected


def begin(song, params, version, allow_returns=False):
    tracks,writes = _flatten(params)
    if not allow_returns and any(not re.fullmatch(r'track-(?:0|[1-9][0-9]*)',row['trackId'] or '') for row in tracks):
        raise ValueError('ordinary or Group track IDs required')
    query = {'trackIds':[row['trackId'] for row in tracks],'fields':sorted({field for _,field,_ in writes})}
    if type(params.get('expectedStateVersion')) is not int or not isinstance(params.get('before'),dict):raise ValueError('native mixer context and state version required')
    before = context(song,query,version)
    if params['expectedStateVersion'] != version or params['before'] != before:raise ValueError('native mixer owner or context changed after planning')
    _safe(before,writes)
    operation = {'song':song,'params':params,'query':query,'before':before,'expected':before,'writes':[],'error':None}
    rows = {row['trackId']:row for row in before['tracks']}
    if all(_near(_value(rows[t],f),c['value']) for t,f,c in writes):return operation
    # Mute requested parts before other controls; unmute only after preparation.
    writes.sort(key=lambda item:0 if item[1] == 'mute' and item[2]['value'] else 3 if item[1] == 'mute' else 2 if item[1] == 'solo' else 1)
    try:
        with _undo_step(song):
            for track_id,field,change in writes:
                current = context(song,query,version)
                if current != operation['expected']:raise ValueError('native mixer context changed before write')
                index = query['trackIds'].index(track_id)
                if _near(_value(current['tracks'][index],field),change['value']):continue
                track = _device_owner(song,track_id)[1]
                parameter = _control(track,field)
                if _device_owner(song,track_id)[1] != track or _control(track,field) != parameter or context(song,query,version) != operation['expected']:
                    raise ValueError('native mixer control changed during resolution')
                write = {'trackId':track_id,'field':field,'value':change['value'],'writeRequested':True,'nativeReturned':False}
                operation['writes'].append(write)
                if field in ('mute','solo'):setattr(track,field,change['value'])
                else:parameter.value = change['value']
                write['nativeReturned'] = True
                after = context(song,query,version)
                operation['expected'] = _advance(current,after,track_id,field,change['value'])
                if after != operation['expected']:raise ValueError('mixer readback or unrequested context changed after write')
    except Exception as error:
        if not operation['writes']:raise
        operation['error'] = (str(error) or error.__class__.__name__)[:600]
    return operation


def unobserved(operation, version, error):
    return {'stateVersion':version,'trackIds':operation['query']['trackIds'],
            **({'trackId':operation['params']['trackId'],'volume':None,'pan':None,'mute':None,'solo':None,'sends':None} if 'trackId' in operation['params'] else {'tracks':None}),
            'writes':operation['writes'],'writeRequested':bool(operation['writes']),
            'nativeReturned':bool(operation['writes']) and all(row['nativeReturned'] for row in operation['writes']),
            'verified':False,'targetRetained':False,'contextPreserved':False,'requestedChangesVerified':False,
            'observedContext':None,'error':operation['error'],'observationError':None if error is None else (str(error) or error.__class__.__name__)[:600],
            'verification':{'topologyStable':False,'recordingOff':False},
            'limitation':'Exposed mixer controls and selected routes only, not isolation or audible-output proof. Existing solos remain. Writes are not atomic; partial changes remain without rollback or replay.'}


def complete(song, operation, version):
    result = unobserved(operation,version,None)
    try:
        observed = [_return_mixer_record(_device_owner(song,key)[1],int(key[7:])) if key.startswith('return-') else
                    dispatch_request(song,{'method':'get_track_mixer','params':{'trackId':key}},version) for key in operation['query']['trackIds']]
        after = context(song,operation['query'],version)
        expected = copy.deepcopy(operation['expected']);expected['stateVersion'] = version
        retained = song == operation['song'] and after['identityToken'] == operation['before']['identityToken']
        _,writes = _flatten(operation['params'])
        rows = {row['trackId']:row for row in after['tracks']}
        matched = all(_near(_value(rows[t],f),c['value']) for t,f,c in writes)
        if 'trackId' in operation['params']:
            row = observed[0];result.update(volume=row['volume']['value'],pan=row['pan']['value'],mute=row['mute'],solo=row['solo'],sends=row.get('sends',[]))
            if operation['params']['trackId'].startswith('return-'):result['return'] = row
        else:result['tracks'] = observed
        result.update(targetRetained=retained,contextPreserved=retained and expected == after,requestedChangesVerified=retained and matched,
                      observedContext=after,verification={'topologyStable':retained,'recordingOff':after['recordingOff'] and after['launchesClear']})
        result['verified'] = result['contextPreserved'] and result['requestedChangesVerified'] and result['error'] is None
        if not result['verified'] and result['error'] is None:result['error'] = 'native mixer readback or unrequested context did not match the plan'
    except Exception as error:result['observationError'] = (str(error) or error.__class__.__name__)[:600]
    return result


def apply(song, params, version):return complete(song,begin(song,params,version),version+1)
