"""Guarded native track and Group-subtree removal."""
import copy
import re
import uuid
try:
    from .bridge import _track_state_snapshot,_device_chain_snapshot,_undo_step,_set_fingerprint
    from .track_grouping import _material,_budget,_controls,_parent,_ancestors,_global,_sidechain_controls,_auxiliary_routing,_hash
    from .midi_note_removal import _flag
except ImportError:
    from bridge import _track_state_snapshot,_device_chain_snapshot,_undo_step,_set_fingerprint
    from track_grouping import _material,_budget,_controls,_parent,_ancestors,_global,_sidechain_controls,_auxiliary_routing,_hash
    from midi_note_removal import _flag

_song=None
_cache={}


def _indices(song,key):
    if not isinstance(key,str) or not re.fullmatch(r'track-(0|[1-9][0-9]*)',key):raise ValueError('canonical trackId required')
    tracks=tuple(song.tracks);index=int(key[6:])
    if index>=len(tracks):raise ValueError('track is unavailable')
    ancestors=[_ancestors(track,tracks) for track in tracks]
    removed=[i for i,t in enumerate(tracks) if i==index or tracks[index] in ancestors[i]]
    if removed != list(range(index,index+len(removed))):raise ValueError('Group descendants are not contiguous')
    if len(removed)>=len(tracks):raise ValueError('cannot delete the last track or Group subtree')
    return removed


def _relative(value,key):
    if isinstance(value,list):return [_relative(v,key) for v in value]
    if isinstance(value,dict):return {k:('owner'+v[len(key):] if k=='id' and isinstance(v,str) and v.startswith(key+':') else _relative(v,key)) for k,v in value.items() if k not in ('stateVersion','trackId','clipId')}
    return value


def _auxiliary_refs(owners,budget):
    refs=[]
    def visit(devices):
        for device in devices:
            parameters=tuple(device.parameters);budget['devices']+=1;budget['parameters']+=len(parameters)
            if budget['devices']>512 or budget['parameters']>32768:raise ValueError('track removal exceeds 512 devices or 32768 parameters')
            refs.extend((device,parameters))
            if bool(getattr(device,'can_have_chains',False)):
                for chain in [*device.chains,*getattr(device,'return_chains',())]:refs.append(chain);visit(chain.devices)
    for owner in owners:visit(owner.devices)
    return tuple(refs)


def _device_inventory(devices):
    return [{'id':device['id'],'name':device['name'],'className':device['className'],
             'parameterCount':len(device['parameters']),
             'children':[_device_inventory(chain['devices']) for kind in ('chains','returnChains') for chain in device.get(kind,[])]}
            for device in devices]


def _snapshot(song,removed,overrides=None):
    overrides=overrides or {}
    tracks,returns,scenes=tuple(song.tracks),tuple(song.return_tracks),tuple(song.scenes)
    if not 1<=len(tracks)<=256 or len(returns)>64 or len(scenes)>1024:raise ValueError('track removal exceeds track, Return or scene limits')
    if any(_flag(song,name) is not False for name in ('is_playing','record_mode','session_record','is_counting_in')):
        raise ValueError('track removal requires stopped playback, recording and count-in')
    if any(getattr(t,'fired_slot_index',None)!=-1 for t in tracks):raise ValueError('resolve pending or unknown clip launches before track removal')
    if any(_flag(scene,'is_triggered') is not False for scene in scenes):raise ValueError('resolve pending scene launches before track removal')
    rows,native,budget=[],[],_budget()
    for i,track in enumerate(tracks):
        key=f'track-{i}';slots=tuple(track.clip_slots);arrangement=() if bool(track.is_foldable) else tuple(track.arrangement_clips)
        clips=[slot.clip for slot in slots if slot.has_clip]+list(arrangement)
        for slot in slots:
            if _flag(slot,'is_triggered') is not False:raise ValueError('resolve pending slot launches before track removal')
        for clip in clips:
            if any(_flag(clip,name) is not False for name in ('is_recording','is_overdubbing','is_triggered','is_playing')):raise ValueError('resolve clip playback, recording and pending launches before track removal')
            if bool(getattr(clip,'is_audio_clip',False)) and len(getattr(clip,'warp_markers',()))>4096:raise ValueError('track removal supports at most 4096 warp markers per clip')
        if i in removed and _flag(track,'is_frozen') is not False:raise ValueError('resolve frozen target tracks before track removal')
        before_devices=budget['devices'];digest,refs=_material(song,track,budget,overrides.get(i))
        raw=_track_state_snapshot(song,key,0)
        for field in ('id','isGrouped','groupTrackId'):raw['track'].pop(field,None)
        if i in overrides:raw['track']['name']=overrides[i]
        raw.pop('routing')
        rows.append({'trackId':key,'name':str(track.name),'isGroup':bool(track.is_foldable),
                     'sessionClipCount':sum(bool(slot.has_clip) for slot in slots),'arrangementClipCount':len(arrangement),
                     'deviceCount':budget['devices']-before_devices,'devices':_device_inventory(raw['devices']),
                     'clips':[{'location':'session','clipId':f'{key}:clip-{j}','name':str(slot.clip.name)} for j,slot in enumerate(slots) if slot.has_clip]+
                             [{'location':'arrangement','clipId':f'{key}:arrangement-clip-{j}','name':str(clip.name),'startBeats':float(clip.start_time),'endBeats':float(clip.end_time)} for j,clip in enumerate(arrangement)],
                     'contentSha256':_hash([digest,_relative(raw,key)]),
                     'readiness':{'frozen':_flag(track,'is_frozen'),'implicitArm':_flag(track,'implicit_arm')},
                     'slots':[{'hasStopButton':_flag(slot,'has_stop_button')} for slot in slots]})
        native.append(refs)
    retained=[t for i,t in enumerate(tracks) if i not in removed]
    owners=[*retained,*returns,song.master_track]
    sidechains,sidechain_refs=_sidechain_controls(owners)
    auxiliary_refs=_auxiliary_refs([*returns,song.master_track],budget)
    auxiliary=[_relative(_device_chain_snapshot(song,f'return-{i}',0),f'return-{i}') for i in range(len(returns))]+[_relative(_device_chain_snapshot(song,'master',0),'master')]
    data={'filePath':str(getattr(song,'file_path','')),'tracks':rows,'controls':_controls(song,retained,[]),
          'sidechains':sidechains,'auxiliaryRouting':_auxiliary_routing([*returns,song.master_track]),
          'auxiliaryStateSha256':_hash(auxiliary),'globalContext':_global(song)}
    binding=(song,tracks,returns,scenes,song.master_track,tuple(native),sidechain_refs,auxiliary_refs,tuple(_parent(t) for t in tracks))
    if tuple(song.tracks)!=tracks or tuple(song.return_tracks)!=returns or tuple(song.scenes)!=scenes:raise ValueError('track removal topology changed during read')
    return data,binding


def _dependencies(data,removed):
    names={data['tracks'][i]['name'] for i in removed}
    routes=[route for row in data['controls'] for route in row['routing'].values()]
    routes += data['sidechains']+data['auxiliaryRouting']
    for route in routes:
        value=route.get('type',{})
        if value.get('name') in names or value.get('id') in names:raise ValueError('resolve exposed routing or sidechain dependencies before track removal')


def context(song,params,version):
    global _song
    key=params.get('trackId');removed=_indices(song,key);data,binding=_snapshot(song,removed)
    _dependencies(data,removed)
    if _snapshot(song,removed)!=(data,binding):raise ValueError('track removal material changed during read')
    if not callable(getattr(song,'delete_track',None)):raise ValueError('native track removal is unavailable')
    if _song!=song:_song=song;_cache.clear()
    cached=_cache.get(key)
    if cached is None or cached[0]!=binding:
        if len(_cache)>=32:del _cache[next(iter(_cache))]
        cached=(binding,str(uuid.uuid4()));_cache[key]=cached
    return {'stateVersion':version,'trackId':key,'setFingerprint':_set_fingerprint(song),'identityToken':cached[1],
            'removedTracks':[data['tracks'][i] for i in removed],**data}


def begin(song,params,version):
    target=params.get('target',{});key=target.get('targetId');before=context(song,{'trackId':key},version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion']!=version or params.get('trackRemovalContext')!=before:raise ValueError('track removal identity or material changed; review a fresh plan')
    if target.get('name')!=before['removedTracks'][0]['name']:raise ValueError('track removal target changed')
    if params.get('allowContent') is not True:raise ValueError('allowContent: true is required for track contents, including unexposed automation')
    removed=_indices(song,key);_,binding=_snapshot(song,removed);kept=[i for i in range(len(binding[1])) if i not in removed]
    operation={'before':before,'binding':binding,'kept':kept,'target':copy.deepcopy(target),'attempted':False,'returned':False,'nativeError':None,'error':None,'lastRead':None}
    try:
        with _undo_step(song):
            if context(song,{'trackId':key},version)!=before:raise ValueError('track removal context changed before deletion')
            operation['attempted']=True;song.delete_track(removed[0]);operation['returned']=True
    except Exception as error:
        if not operation['attempted']:raise
        operation['nativeError']=operation['error']=(str(error) or error.__class__.__name__)[:600]
    return operation


def _receipt(operation,version):
    return {'stateVersion':version,'deleted':operation['target'],'removedTracks':operation['before']['removedTracks'],
            'deleteRequested':operation['attempted'],'nativeReturned':operation['returned'],'deletionVerified':False,
            'targetsAbsent':None,'existingLayoutPreserved':False,'remainingMaterialPreserved':None,'controlsPreserved':None,
            'hiddenStateBackedUp':False,'sourceFileBytesVerified':False,'readbackPending':False,'observed':None,
            'verification':{'topologyStable':False,'recordingOff':False},'error':operation['nativeError'] or operation['error'],'observationError':None}


def unobserved(operation,version,error):
    result=_receipt(operation,version);result['observationError']=(str(error) or error.__class__.__name__)[:600];return result


def _observe(song,operation,version):
    result,observed=_receipt(operation,version),None
    before,binding,kept=operation['before'],operation['binding'],operation['kept']
    try:
        if song!=binding[0]:raise ValueError('Set changed before track removal readback')
        retained=tuple(binding[1][i] for i in kept)
        layout=tuple(song.tracks)==retained and tuple(song.return_tracks)==binding[2] and tuple(song.scenes)==binding[3] and song.master_track==binding[4]
        result['existingLayoutPreserved']=layout;result['targetsAbsent']=True if layout else None
        if not layout:raise ValueError('track removal or remaining native topology is unconfirmed')
        overrides,labels,renamed={},{},[]
        for new,old in enumerate(kept):
            previous=before['tracks'][old]['name'];current=str(retained[new].name);prefix=f'{old+1}-'
            if previous.startswith(prefix) and current==f'{new+1}-'+previous[len(prefix):] and previous!=current:
                overrides[new]=previous;renamed.append({'sourceTrackId':f'track-{old}','trackId':f'track-{new}','before':previous,'after':current})
                if sum(row['name']==previous for row in before['tracks'])==1:labels[previous]=current
        observed,current_binding=_snapshot(song,[],overrides)
        stable=_snapshot(song,[],overrides)==(observed,current_binding)
        native=(current_binding[5]==tuple(binding[5][i] for i in kept) and current_binding[6:8]==binding[6:8] and current_binding[8]==tuple(binding[8][i] for i in kept))
        material=native and all(row['contentSha256']==before['tracks'][old]['contentSha256'] and row['readiness']==before['tracks'][old]['readiness'] and row['slots']==before['tracks'][old]['slots'] for row,old in zip(observed['tracks'],kept))
        def translated(value):
            if isinstance(value,dict):return {k:translated(v) for k,v in value.items()}
            if isinstance(value,list):return [translated(v) for v in value]
            return labels.get(value,value) if isinstance(value,str) else value
        expected_controls=translated(before['controls'])
        controls=(observed['controls']==expected_controls and observed['sidechains']==translated(before['sidechains']) and observed['auxiliaryRouting']==translated(before['auxiliaryRouting']) and observed['auxiliaryStateSha256']==before['auxiliaryStateSha256'] and observed['globalContext']==before['globalContext'] and observed['filePath']==before['filePath'])
        result.update(remainingMaterialPreserved=material,controlsPreserved=controls,renumberedTrackNames=renamed,
                      observed={'tracks':observed['tracks'],'controls':observed['controls']},verification={'topologyStable':stable,'recordingOff':True})
        result['deletionVerified']=operation['returned'] and result['error'] is None and stable and material and controls
        if not result['deletionVerified'] and result['error'] is None:result['error']='track removal readback did not match the plan'
    except Exception as error:result['observationError']=(str(error) or error.__class__.__name__)[:600]
    return result,observed


def complete(song,operation,version):
    result,observed=_observe(song,operation,version)
    if result['deletionVerified'] and observed!=operation['lastRead']:
        result['deletionVerified']=False;result['readbackPending']=True;result['error']='native track removal readback has not stabilized'
    operation['lastRead']=observed;return result


def remove(song,params,version):return _observe(song,begin(song,params,version),version+1)[0]
