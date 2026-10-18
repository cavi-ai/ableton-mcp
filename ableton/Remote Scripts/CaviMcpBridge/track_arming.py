"""Bind a single track arm change to native input and recording readiness."""
import copy
import re
import uuid
try:
    from .bridge import _track, _routing_option, _undo_step
    from .clip_mute import _flag
except ImportError:
    from bridge import _track, _routing_option, _undo_step
    from clip_mute import _flag

_song = None
_identities = {}


def _inspect(song, track_id):
    tracks = tuple(song.tracks)
    scenes = tuple(song.scenes)
    if len(tracks) > 256:
        raise ValueError('track arming supports at most 256 tracks including Groups')
    if len(scenes) > 4096:
        raise ValueError('track arming supports at most 4096 scenes')
    _, target = _track(song, track_id)
    references, arms, recording, pending, count = [], [], [], [], 0
    for index, track in enumerate(tracks):
        group, capable = _flag(track, 'is_foldable'), _flag(track, 'can_be_armed')
        arms.append({'trackId':'track-'+str(index), 'name':str(track.name), 'canBeArmed':capable,
                     'armed':_flag(track, 'arm'), 'implicitArm':_flag(track, 'implicit_arm')})
        fired = getattr(track, 'fired_slot_index', None)
        pending.append(None if type(fired) is not int else fired != -1)
        if group is True:
            continue
        if group is None:
            recording.append(None)
        slots, arrangement = tuple(track.clip_slots), tuple(track.arrangement_clips)
        count += len(slots)+len(arrangement)
        if count > 16384:
            raise ValueError('track arming inspection exceeds 16384 Session slots and Arrangement clips')
        clips = tuple(slot.clip if slot.has_clip else None for slot in slots)
        references.append((track, slots, clips, arrangement))
        pending.extend(_flag(slot, 'is_triggered') for slot in slots)
        for clip in [item for item in clips if item is not None]+list(arrangement):
            recording.extend((_flag(clip, 'is_recording'), _flag(clip, 'is_overdubbing')))
            pending.append(_flag(clip, 'is_triggered'))
    pending.extend(_flag(scene, 'is_triggered') for scene in scenes)
    identity = song, tracks, target, tuple(target.devices), tuple(references), scenes
    return identity, arms, recording, pending, count


def _input(track, modern, legacy):
    try:
        option = getattr(track, modern) if hasattr(track, modern) else getattr(track, legacy)
        return None if option is None else _routing_option(option)
    except Exception:
        return None


def _input_context(track, index):
    try:
        monitoring = int(track.current_monitoring_state)
    except Exception:
        monitoring = None
    return {'trackId':'track-'+str(index),
            'inputType':_input(track,'input_routing_type','current_input_routing'),
            'inputChannel':_input(track,'input_routing_channel','current_input_sub_routing'),
            'monitoring':monitoring}


def context(song, params, version):
    global _song
    track_id = params.get('trackId')
    if not isinstance(track_id, str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)', track_id):
        raise ValueError('canonical ordinary track ID required')
    identity, arms, recording, pending, count = _inspect(song, track_id)
    target = identity[2]
    if _song != song:
        _song = song
        _identities.clear()
    cached = _identities.get(track_id)
    if cached is None or cached[0] != identity:
        if len(_identities) >= 64: _identities.pop(next(iter(_identities)))
        cached = identity, str(uuid.uuid4())
        _identities[track_id] = cached
    flags = {key:_flag(song, attribute) for key,attribute in (
        ('playing','is_playing'), ('arrangementRecord','record_mode'),
        ('sessionRecord','session_record'), ('countingIn','is_counting_in'))}
    row = arms[int(track_id[6:])]
    inputs = [_input_context(track,index) for index,track in enumerate(identity[1])]
    input_context = inputs[int(track_id[6:])]
    info = {**row, 'id':track_id, 'isGroup':_flag(target,'is_foldable'),
            'isFrozen':_flag(target,'is_frozen'), **input_context}
    reasons = []
    if info['isGroup'] is not False: reasons.append('ordinary_track_required')
    if info['canBeArmed'] is not True: reasons.append('native_track_cannot_be_armed')
    if info['isFrozen'] is not False: reasons.append('frozen_or_unknown')
    if info['armed'] is None: reasons.append('arm_state_unavailable')
    if info['implicitArm'] is not False: reasons.append('implicit_arm_active_or_unknown')
    if info['inputType'] is None or info['inputChannel'] is None or info['monitoring'] not in (0,1,2):
        reasons.append('input_context_unavailable')
    if flags['playing'] is None or any(v is not False for k,v in flags.items() if k != 'playing') or any(v is not False for v in recording):
        reasons.append('recording_or_count_in_active_or_unknown')
    if any(v is not False for v in pending): reasons.append('pending_launch_or_unknown')
    if any(r['canBeArmed'] is not False and (r['armed'] is None or r['implicitArm'] is None) for r in arms):
        reasons.append('other_arm_state_unavailable')
    if _inspect(song, track_id)[0] != identity:
        raise ValueError('track layout changed during arm inspection')
    return {'stateVersion':version, 'trackId':track_id, 'identityToken':cached[1],
            'target':info, 'armStates':arms, 'inputStates':inputs, 'transport':flags, 'inspectedSlotAndClipCount':count,
            'readyToChange':not reasons, 'reasons':reasons}


def begin(song, params, version):
    if type(params.get('armed')) is not bool:
        raise ValueError('armed must be an explicit boolean')
    if not isinstance(params.get('before'), dict) or type(params.get('expectedStateVersion')) is not int:
        raise ValueError('native track arm context and state version required')
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('native track arm context changed after planning')
    if not before['readyToChange']:
        raise ValueError('track arming refused: '+', '.join(before['reasons']))
    operation = {'before':before, 'params':params, 'song':song, 'writeRequested':False,
                 'nativeReturned':False, 'error':None, 'lastRead':None}
    if before['target']['armed'] == params['armed']:
        return operation
    try:
        with _undo_step(song):
            if context(song, params, version) != before:
                raise ValueError('native track arm context changed at undo entry')
            operation['writeRequested'] = True
            _track(song, params['trackId'])[1].arm = params['armed']
            operation['nativeReturned'] = True
    except Exception as error:
        if not operation['writeRequested']: raise
        operation['error'] = (str(error) or error.__class__.__name__)[:600]
    return operation


def _receipt(operation, version):
    return {'stateVersion':version, 'trackId':operation['params']['trackId'], 'armed':None,
            'writeRequested':operation['writeRequested'], 'nativeReturned':operation['nativeReturned'],
            'verified':False, 'targetRetained':False, 'otherArmsPreserved':False,
            'contextPreserved':False, 'observed':None, 'error':operation['error'], 'observationError':None,
            'verification':{'topologyStable':False, 'recordingOff':False},
            'limitation':'Arm-state and exposed input/readiness checks only. Not a recording, signal or audible-output verification. Partial changes remain without rollback or replay.'}


def unobserved(operation, version, error):
    result = _receipt(operation, version)
    result['observationError'] = (str(error) or error.__class__.__name__)[:600]
    return result


def complete(song, operation, version):
    result = _receipt(operation, version)
    try:
        observed = context(song, operation['params'], version)
        before = operation['before']
        expected = copy.deepcopy(before)
        expected['stateVersion'] = version
        expected['target']['armed'] = operation['params']['armed']
        expected['armStates'][int(operation['params']['trackId'][6:])]['armed'] = operation['params']['armed']
        retained = song == operation['song'] and observed['identityToken'] == before['identityToken']
        other = lambda rows:[row for row in rows if row['trackId'] != result['trackId']]
        result.update(armed=observed['target']['armed'], observed=observed, targetRetained=retained,
                      otherArmsPreserved=retained and other(observed['armStates']) == other(before['armStates']),
                      contextPreserved=retained and observed == expected,
                      verification={'topologyStable':retained, 'recordingOff':observed['readyToChange']})
        result['verified'] = result['contextPreserved'] and result['error'] is None and (
            not result['writeRequested'] or result['nativeReturned'])
        if not result['verified'] and result['error'] is None:
            result['error'] = 'native arm readback or unrequested context did not match the plan'
    except Exception as error:
        result['observationError'] = (str(error) or error.__class__.__name__)[:600]
    return result


def apply(song, params, version):
    return complete(song, begin(song, params, version), version+1)
