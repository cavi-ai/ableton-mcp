"""Guarded Session row removal with retained partial-work evidence."""
import copy
import re
import uuid
try:
    from .bridge import _scene_record, _set_fingerprint, _undo_step
    from .clip_duplication import _content
    from .midi_note_removal import _flag
except ImportError:
    from bridge import _scene_record, _set_fingerprint, _undo_step
    from clip_duplication import _content
    from midi_note_removal import _flag

_song = None
_cache = {}


def _scene(scene):
    result = _scene_record(scene, 0)
    result.pop('id')
    result['color'] = getattr(scene, 'color', None)
    for name in ('tempo', 'time_signature_numerator', 'time_signature_denominator'):
        result['stored_'+name] = getattr(scene, name, None)
    return result


def _snapshot(song, version):
    tracks, scenes = tuple(song.tracks), tuple(song.scenes)
    if len(tracks) > 256 or len(scenes) > 1024 or len(tracks)*len(scenes) > 16384:
        raise ValueError('scene removal supports at most 256 tracks, 1024 scenes and 16384 Session slots')
    flags = {name:_flag(song,name) for name in ('record_mode','session_record','is_counting_in')}
    if any(value is not False for value in flags.values()):
        raise ValueError('resolve recording and count-in before scene removal')
    if any(_flag(scene,'is_triggered') is not False for scene in scenes):
        raise ValueError('resolve unknown or pending scene launches before removal')
    rows, layouts, note_count = [], [], 0
    for i, track in enumerate(tracks):
        slots = tuple(track.clip_slots)
        if len(slots) != len(scenes): raise ValueError('inconsistent scene/slot layout')
        if getattr(track,'fired_slot_index',None) != -1:
            raise ValueError('resolve unknown or pending clip launches before scene removal')
        records, layout = [], []
        for j, slot in enumerate(slots):
            if _flag(slot,'is_triggered') is not False: raise ValueError('resolve pending slot launches before removal')
            clip = slot.clip if slot.has_clip else None
            if clip is not None and any(_flag(clip,name) is not False for name in ('is_recording','is_overdubbing','is_triggered')):
                raise ValueError('resolve clip recording, overdubbing and pending launches before removal')
            content = _content(song,f'track-{i}',f'track-{i}:clip-{j}',version) if clip is not None else None
            note_count += len((content or {}).get('notes',[]))
            if note_count > 16384: raise ValueError('scene removal supports at most 16384 stored Session MIDI notes; no sampling')
            records.append({'hasStopButton':_flag(slot,'has_stop_button'),'playing':_flag(clip,'is_playing') if clip is not None else False,'content':content})
            if records[-1]['playing'] is None: raise ValueError('native clip playback state is unavailable')
            if records[-1]['hasStopButton'] is None: raise ValueError('native stop button state is unavailable')
            layout.append((slot,clip))
        layouts.append(tuple(layout))
        rows.append({'name':track.name,'isGroup':_flag(track,'is_foldable'),'frozen':_flag(track,'is_frozen'),
                     'armed':_flag(track,'arm') if getattr(track,'can_be_armed',False) else False,
                     'implicitArm':_flag(track,'implicit_arm'),'mute':_flag(track,'mute'),'solo':_flag(track,'solo'),
                     'arrangementOverride':_flag(track,'back_to_arranger'),
                     'playingSlot':getattr(track,'playing_slot_index',None),'slots':records})
    data = {'setFingerprint':_set_fingerprint(song),'setPath':getattr(song,'file_path',''),'scenes':[_scene(s) for s in scenes], 'tracks':rows,
            'playback':{'isPlaying':_flag(song,'is_playing'),'tempo':float(song.tempo),
                        'numerator':song.signature_numerator,'denominator':song.signature_denominator,
                        'arrangementOverride':_flag(song,'back_to_arranger')}}
    binding = (song, tracks, scenes, tuple(layouts))
    if tuple(song.tracks) != tracks or tuple(song.scenes) != scenes:
        raise ValueError('scene removal topology changed during read')
    return data, binding


def _index(params):
    key=params.get('sceneId')
    if not isinstance(key,str) or not re.fullmatch(r'scene-(0|[1-9][0-9]*)',key):
        raise ValueError('canonical sceneId required')
    return int(key[6:])


def context(song, params, version):
    global _song
    index=_index(params)
    data,binding=_snapshot(song,version)
    if len(binding[2]) <= 1: raise ValueError('cannot delete the last scene')
    if index >= len(binding[2]): raise ValueError('scene is unavailable')
    for row in data['tracks']:
        slot=row['slots'][index]
        if slot['playing'] or row['playingSlot'] == index:
            raise ValueError('resolve the playing target row before scene removal')
        if slot['content'] is not None and row['frozen'] is not False:
            raise ValueError('resolve frozen target tracks before scene removal')
    if not callable(getattr(song,'delete_scene',None)): raise ValueError('native scene removal is unavailable')
    if _snapshot(song,version) != (data,binding): raise ValueError('scene removal context changed during read')
    if _song != song:
        _song=song
        _cache.clear()
    cached=_cache.get(index)
    if cached is None or cached[0] != binding:
        if len(_cache) >= 32:del _cache[next(iter(_cache))]
        cached=(binding,str(uuid.uuid4()))
        _cache[index]=cached
    occupied=[{'trackId':f'track-{i}','clipId':f'track-{i}:clip-{index}','name':row['slots'][index]['content']['name']}
              for i,row in enumerate(data['tracks']) if row['slots'][index]['content'] is not None]
    return {'stateVersion':version,'sceneId':params['sceneId'],'identityToken':cached[1],
            'occupiedClips':occupied,**data}


def begin(song, params, version):
    target=params.get('target',{})
    read_params={'sceneId':target.get('targetId')}
    before=context(song,read_params,version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or params.get('sceneRemovalContext') != before:
        raise ValueError('scene removal identity or material changed; review a fresh plan')
    index=_index(read_params)
    if target.get('name') != before['scenes'][index]['name']: raise ValueError('scene removal target changed')
    if before['occupiedClips'] and params.get('allowContent') is not True:
        raise ValueError('allowContent: true is required to delete a scene containing clips')
    _,binding=_snapshot(song,version)
    attempted,returned,error=False,False,None
    try:
        with _undo_step(song):
            if context(song,read_params,version) != before: raise ValueError('scene removal context changed before deletion')
            attempted=True
            song.delete_scene(index)
            returned=True
    except Exception as failure:
        if not attempted:raise
        error=(str(failure) or failure.__class__.__name__)[:600]
    return {'target':copy.deepcopy(target),'before':before,'binding':binding,'index':index,
            'attempted':attempted,'returned':returned,'nativeError':error,'error':error,'lastRead':None}


def _receipt(operation,version):
    return {'stateVersion':version,'deleted':operation['target'],'deleteRequested':operation['attempted'],
            'nativeReturned':operation['returned'],'deletionVerified':False,'targetAbsent':None,
            'existingLayoutPreserved':False,'remainingMaterialPreserved':None,'playbackPreserved':None,
            'hiddenStateBackedUp':False,'sourceFileBytesVerified':False,'readbackPending':False,
            'observed':None,'verification':{'topologyStable':False,'recordingOff':False},
            'error':operation['nativeError'] or operation['error'],'observationError':None}


def unobserved(operation,version,error):
    result=_receipt(operation,version)
    result['observationError']=(str(error) or error.__class__.__name__)[:600]
    return result


def _layout(song,binding,index):
    original_song,tracks,scenes,layouts=binding
    if song != original_song or tuple(song.tracks) != tracks or tuple(song.scenes) != scenes[:index]+scenes[index+1:]:return False
    return all(tuple((slot,slot.clip if slot.has_clip else None) for slot in track.clip_slots) == original[:index]+original[index+1:]
               for track,original in zip(tracks,layouts))


def _observe(song,operation,version):
    result,observed=_receipt(operation,version),None
    before,binding,index=operation['before'],operation['binding'],operation['index']
    try:
        if song != binding[0]:raise ValueError('Set changed before scene removal readback')
        layout=_layout(song,binding,index)
        result['targetAbsent']=True if layout else None
        result['existingLayoutPreserved']=layout
        if not layout:raise ValueError('scene removal or remaining native layout is unconfirmed')
        observed,current_binding=_snapshot(song,version)
        stable=_snapshot(song,version) == (observed,current_binding) and _layout(song,binding,index)
        result['observed']={'scenes':[dict(scene,id=f'scene-{i}') for i,scene in enumerate(observed['scenes'])], 'playback':observed['playback']}
        result['verification']={'topologyStable':stable,'recordingOff':True}
        expected=copy.deepcopy({k:v for k,v in before.items() if k not in ('stateVersion','sceneId','identityToken','occupiedClips','setFingerprint')})
        expected['scenes'].pop(index)
        for row in expected['tracks']:
            row['slots'].pop(index)
            if row['playingSlot'] is not None and row['playingSlot'] > index:row['playingSlot']-=1
        actual={k:v for k,v in observed.items() if k != 'setFingerprint'}
        result['remainingMaterialPreserved']=actual['scenes'] == expected['scenes'] and actual['tracks'] == expected['tracks']
        result['playbackPreserved']=actual['playback'] == expected['playback'] and all(row['playingSlot'] == old['playingSlot'] and [slot['playing'] for slot in row['slots']] == [slot['playing'] for slot in old['slots']] for row,old in zip(actual['tracks'],expected['tracks']))
        result['deletionVerified']=operation['returned'] and result['error'] is None and stable and result['targetAbsent'] and actual == expected
        if not result['deletionVerified'] and result['error'] is None:result['error']='scene removal readback did not match the plan'
    except Exception as failure:result['observationError']=(str(failure) or failure.__class__.__name__)[:600]
    return result,observed


def complete(song,operation,version):
    result,observed=_observe(song,operation,version)
    if result['deletionVerified'] and observed != operation['lastRead']:
        result['deletionVerified']=False
        result['readbackPending']=True
        result['error']='native scene removal readback has not stabilized'
    operation['lastRead']=observed
    return result


def remove(song,params,version):
    return _observe(song,begin(song,params,version),version+1)[0]
