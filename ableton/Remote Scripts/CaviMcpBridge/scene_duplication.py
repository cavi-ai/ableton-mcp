"""Native whole-row Session copies with retained partial-work evidence."""
import copy
import re
import uuid
try:
    from .bridge import _scene_record, _set_fingerprint, _undo_step
    from .clip_duplication import _content, _comparable
    from .midi_note_removal import _flag
except ImportError:
    from bridge import _scene_record, _set_fingerprint, _undo_step
    from clip_duplication import _content, _comparable
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
        raise ValueError('scene copy supports at most 256 tracks, 1024 scenes and 16384 Session slots')
    flags = {name:_flag(song,name) for name in ('record_mode','session_record','is_counting_in')}
    if any(value is not False for value in flags.values()):
        raise ValueError('resolve recording and count-in before scene copy')
    if any(_flag(scene,'is_triggered') is not False for scene in scenes):
        raise ValueError('resolve unknown or pending scene launches before copy')
    rows, layouts, note_count = [], [], 0
    for i, track in enumerate(tracks):
        slots = tuple(track.clip_slots)
        if len(slots) != len(scenes): raise ValueError('inconsistent scene/slot layout')
        if getattr(track,'fired_slot_index',None) != -1:
            raise ValueError('resolve unknown or pending clip launches before scene copy')
        records, layout = [], []
        for j, slot in enumerate(slots):
            if _flag(slot,'is_triggered') is not False: raise ValueError('resolve pending slot launches before copy')
            clip = slot.clip if slot.has_clip else None
            if clip is not None and any(_flag(clip,name) is not False for name in ('is_recording','is_overdubbing','is_triggered')):
                raise ValueError('resolve clip recording, overdubbing and pending launches before copy')
            content = _content(song,f'track-{i}',f'track-{i}:clip-{j}',version) if clip is not None else None
            note_count += len((content or {}).get('notes',[]))
            if note_count > 16384: raise ValueError('scene copy supports at most 16384 stored Session MIDI notes; no sampling')
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
        raise ValueError('scene copy topology changed during read')
    return data, binding


def _index(params):
    key = params.get('sceneId')
    if not isinstance(key,str) or not re.fullmatch(r'scene-(0|[1-9][0-9]*)',key):
        raise ValueError('canonical sceneId required')
    return int(key[6:])


def context(song, params, version):
    global _song
    index = _index(params)
    data, binding = _snapshot(song,version)
    if index >= len(binding[2]): raise ValueError('scene is unavailable')
    if len(binding[2]) >= 1024 or len(binding[1])*(len(binding[2])+1) > 16384:
        raise ValueError('scene copy needs room for one inserted row')
    for row in data['tracks']:
        if row['slots'][index]['content'] is not None and row['frozen'] is not False:
            raise ValueError('resolve frozen source tracks before scene copy')
    total = sum(len((slot['content'] or {}).get('notes',[])) for row in data['tracks'] for slot in row['slots'])
    added = sum(len((row['slots'][index]['content'] or {}).get('notes',[])) for row in data['tracks'])
    if total+added > 16384: raise ValueError('copied row exceeds the 16384 Session MIDI note readback limit')
    if not callable(getattr(song,'duplicate_scene',None)): raise ValueError('native scene duplication is unavailable')
    if _snapshot(song,version) != (data,binding): raise ValueError('scene copy material changed during read')
    if _song != song:
        _song = song
        _cache.clear()
    cached = _cache.get(index)
    if cached is None or cached[0] != binding:
        if len(_cache) >= 32: del _cache[next(iter(_cache))]
        cached = (binding,str(uuid.uuid4()))
        _cache[index] = cached
    return {'stateVersion':version,'sceneId':params['sceneId'],'destinationId':f'scene-{index+1}',
            'identityToken':cached[1],**data}


def _layout(song, binding, index):
    original_song, tracks, scenes, layouts = binding
    if song != original_song: return False
    current = tuple(song.scenes)
    if tuple(song.tracks) != tracks or len(current) != len(scenes)+1: return False
    if current[:index]+current[index+1:] != scenes or current[index] in scenes: return False
    original_clips = tuple(clip for layout in layouts for _,clip in layout if clip is not None)
    for track, original in zip(tracks,layouts):
        slots = tuple((slot,slot.clip if slot.has_clip else None) for slot in track.clip_slots)
        if len(slots) != len(original)+1 or slots[:index]+slots[index+1:] != original: return False
        if slots[index][0] in tuple(s[0] for s in original): return False
        if slots[index][1] is not None and slots[index][1] in original_clips: return False
    return True


def begin(song, params, version):
    target = params.get('target',{})
    read_params = {'sceneId':target.get('targetId')}
    before = context(song,read_params,version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or params.get('sceneCopyContext') != before:
        raise ValueError('scene copy identity or material changed; review a fresh plan')
    index = _index(read_params)+1
    if target.get('destinationId') != f'scene-{index}' or target.get('name') != before['scenes'][index-1]['name']:
        raise ValueError('scene copy target changed')
    _, binding = _snapshot(song,version)
    attempted, returned, error = False, False, None
    try:
        with _undo_step(song):
            if context(song,read_params,version) != before: raise ValueError('scene copy context changed before insertion')
            attempted = True
            song.duplicate_scene(index-1)
            returned = True
    except Exception as failure:
        if not attempted: raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    return {'before':before,'binding':binding,'index':index,'target':copy.deepcopy(target),
            'attempted':attempted,'returned':returned,'nativeError':error,'error':error,'lastRead':None}


def _receipt(operation, version):
    return {'stateVersion':version,'target':operation['target'],'copyRequested':operation['attempted'],'nativeReturned':operation['returned'],
              'copyVerified':False,'sceneId':None,'scene':None,'existingLayoutPreserved':False,
              'existingMaterialPreserved':None,'copiedMaterialVerified':None,'playbackPreserved':None,
              'hiddenStateVerified':False,'sourceFileBytesVerified':False,'error':operation['nativeError'] or operation['error'],
              'observationError':None,'observed':None,'verification':{'topologyStable':False,'recordingOff':False},'readbackPending':False}


def unobserved(operation, version, error):
    result = _receipt(operation,version)
    result['observationError'] = (str(error) or error.__class__.__name__)[:600]
    return result


def _observe(song, operation, version):
    before, binding, index = operation['before'],operation['binding'],operation['index']
    error, returned = operation['nativeError'] or operation['error'], operation['returned']
    result, observed = _receipt(operation,version), None
    try:
        layout = _layout(song,binding,index)
        result['existingLayoutPreserved'] = layout
        if not layout: raise ValueError('inserted scene ownership or existing layout is unconfirmed')
        observed, observed_binding = _snapshot(song,version)
        stable = _snapshot(song,version) == (observed,observed_binding) and _layout(song,binding,index)
        result['verification'] = {'topologyStable':stable,'recordingOff':True}
        result['observed'] = {'scene':observed['scenes'][index],'rows':[row['slots'][index] for row in observed['tracks']]}
        reduced = copy.deepcopy(observed)
        copied = reduced['scenes'].pop(index) == before['scenes'][index-1]
        copy_playing = any(row['playingSlot'] == index for row in observed['tracks'])
        for old, row in zip(before['tracks'],reduced['tracks']):
            inserted = row['slots'].pop(index)
            source = old['slots'][index-1]
            copied = copied and inserted['hasStopButton'] == source['hasStopButton'] and inserted['playing'] is False
            copied = copied and (_comparable(inserted['content']) == _comparable(source['content']) if source['content'] is not None and inserted['content'] is not None else inserted['content'] == source['content'])
            if row['playingSlot'] is not None and row['playingSlot'] >= index: row['playingSlot'] -= 1
        reduced.pop('setFingerprint')
        expected = {key:value for key,value in before.items() if key not in ('stateVersion','sceneId','destinationId','identityToken','setFingerprint')}
        result['existingMaterialPreserved'] = reduced['scenes'] == expected['scenes'] and reduced['tracks'] == expected['tracks']
        result['playbackPreserved'] = not copy_playing and reduced['playback'] == expected['playback'] and all(row['playingSlot'] == old['playingSlot'] and [slot['playing'] for slot in row['slots']] == [slot['playing'] for slot in old['slots']] for row,old in zip(reduced['tracks'],expected['tracks']))
        result['copiedMaterialVerified'] = copied and stable
        result['copyVerified'] = returned and error is None and stable and copied and not copy_playing and reduced == expected
        if returned:
            result['sceneId'] = f'scene-{index}'
            result['scene'] = _scene_record(song.scenes[index],index)
        if not result['copyVerified'] and result['error'] is None: result['error']='scene copy readback did not match the plan'
    except Exception as failure:
        result['observationError']=(str(failure) or failure.__class__.__name__)[:600]
    return result, observed


def complete(song, operation, version):
    result, observed = _observe(song,operation,version)
    if result['copyVerified'] and observed != operation['lastRead']:
        result['copyVerified'] = False
        result['readbackPending'] = True
        result['error'] = 'native scene copy readback has not stabilized'
    operation['lastRead'] = observed
    return result


def duplicate(song, params, version):
    return _observe(song,begin(song,params,version),version+1)[0]
