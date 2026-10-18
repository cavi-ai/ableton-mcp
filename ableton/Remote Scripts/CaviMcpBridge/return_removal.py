"""One Return deletion with bound send destinations and retained material."""
import copy
import re
import uuid
try:
    from .bridge import (_track_state_snapshot,_device_chain_snapshot,_clip_timing,_audio_clip_state,
                         _midi_note_record,_song_musical_context,_transport_recording_context,_set_mixer,
                         _scene_record,_set_fingerprint,_undo_step)
    from .track_grouping import _hash,_parent,_sidechain_controls,_auxiliary_routing
    from .track_send import send_record
    from .track_volume import volume_record
    from .midi_note_removal import _flag
except ImportError:
    from bridge import (_track_state_snapshot,_device_chain_snapshot,_clip_timing,_audio_clip_state,
                        _midi_note_record,_song_musical_context,_transport_recording_context,_set_mixer,
                        _scene_record,_set_fingerprint,_undo_step)
    from track_grouping import _hash,_parent,_sidechain_controls,_auxiliary_routing
    from track_send import send_record
    from track_volume import volume_record
    from midi_note_removal import _flag

_song=None
_cache={}


def _index(song,key):
    if not isinstance(key,str) or not re.fullmatch(r'return-(0|[1-9][0-9]*)',key):raise ValueError('canonical returnTrackId required')
    index=int(key[7:])
    if index>=len(song.return_tracks):raise ValueError('Return is unavailable')
    return index


def _relative(value,key):
    if isinstance(value,list):return [_relative(v,key) for v in value]
    if isinstance(value,dict):return {k:('owner'+v[len(key):] if k=='id' and isinstance(v,str) and v.startswith(key+':') else _relative(v,key)) for k,v in value.items() if k not in ('stateVersion','trackId','clipId')}
    return value


def _snapshot(song,removed=None,overrides=None):
    overrides=overrides or {};tracks,returns,scenes=tuple(song.tracks),tuple(song.return_tracks),tuple(song.scenes)
    if len(tracks)>256 or len(returns)>64 or len(scenes)>1024:raise ValueError('Return removal exceeds track, Return or scene limits')
    if any(_flag(song,n) is not False for n in ('is_playing','record_mode','session_record','is_counting_in')):raise ValueError('Return removal requires stopped playback, recording and count-in')
    if any(getattr(t,'fired_slot_index',None)!=-1 for t in tracks) or any(_flag(s,'is_triggered') is not False for s in scenes):raise ValueError('resolve pending or unknown launches before Return removal')
    rows,refs,sends,send_refs=[],[],[],[];budget=dict(devices=0,parameters=0,slots=0,notes=0)
    def devices(items,native):
        for device in items:
            parameters=tuple(device.parameters);budget['devices']+=1;budget['parameters']+=len(parameters)
            if budget['devices']>512 or budget['parameters']>32768:raise ValueError('Return removal exceeds 512 devices or 32768 parameters')
            native.extend((device,parameters))
            if bool(getattr(device,'can_have_chains',False)):
                for chain in [*device.chains,*getattr(device,'return_chains',())]:native.append(chain);devices(chain.devices,native)
    for i,owner in enumerate([*tracks,*returns,song.master_track]):
        ordinary=i<len(tracks);ret=len(tracks)<=i<len(tracks)+len(returns);ri=i-len(tracks)
        key=f'track-{i}' if ordinary else f'return-{ri}' if ret else 'master'
        native=[owner,owner.mixer_device];devices(owner.devices,native)
        controls=["volume","panning"]
        if int(getattr(owner.mixer_device,"panning_mode",0))==1:controls.extend(("left_split_stereo","right_split_stereo"))
        if not ordinary and not ret:controls.extend(("cue_volume","crossfader"))
        parameters=[(n,getattr(owner.mixer_device,n)) for n in controls]
        native.append(tuple(p for n,p in parameters))
        if ordinary:
            raw=_track_state_snapshot(song,key,0);raw['mixer'].pop('sends')
            raw['routing']={**{side:{k:raw['routing'][side][k] for k in ('type','channel')} for side in ('input','output')},'monitoring':raw['routing']['monitoring']}
            slots=tuple(owner.clip_slots);arrangement=() if bool(getattr(owner,'is_foldable',False)) else tuple(owner.arrangement_clips)
            budget['slots']+=len(slots)+len(arrangement)
            if budget['slots']>4096:raise ValueError('Return removal exceeds 4096 Session slots and Arrangement clips')
            native.extend(slots);material=[]
            for slot in slots:
                if _flag(slot,'is_triggered') is not False:raise ValueError('resolve pending slot launches before Return removal')
            clips=[(f'{key}:clip-{j}',slot.clip) for j,slot in enumerate(slots) if slot.has_clip]+[(f'{key}:arrangement-clip-{j}',clip) for j,clip in enumerate(arrangement)]
            for clip_id,clip in clips:
                if any(_flag(clip,n) is not False for n in ('is_recording','is_overdubbing','is_triggered','is_playing')):raise ValueError('resolve clip playback, recording and launches before Return removal')
                native.append(clip);row={'name':str(clip.name),'color':getattr(clip,'color',None),'timing':_clip_timing(song,key,clip_id,0)}
                if bool(getattr(clip,'is_audio_clip',False)):
                    if len(getattr(clip,'warp_markers',()))>4096:raise ValueError('Return removal exceeds 4096 audio warp markers')
                    row['audio']=_audio_clip_state(song,key,clip_id,0)
                else:
                    row['notes']=[_midi_note_record(n) for n in clip.get_all_notes_extended()];budget['notes']+=len(row['notes'])
                    if budget['notes']>16384:raise ValueError('Return removal exceeds 16384 stored MIDI notes')
                material.append(row)
            raw.update(clips=material,slots=[{'stop':_flag(s,'has_stop_button')} for s in slots],readiness={'frozen':_flag(owner,'is_frozen'),'implicitArm':_flag(owner,'implicit_arm')})
        else:
            raw=_device_chain_snapshot(song,key,0)
            if ret:raw['name']=overrides.get(ri,str(owner.name));raw['color']=getattr(owner,'color',None)
        raw['mixerParameters']={n:volume_record(p) for n,p in parameters}
        rows.append({'ownerId':key,'name':str(getattr(owner,'name','Main')),'contentSha256':_hash(_relative(raw,key)),
                     **({'devices':raw['devices']} if ret else {})});refs.append(tuple(native))
        if ordinary or ret:
            parameters=tuple(owner.mixer_device.sends)
            if len(parameters)!=len(returns):raise ValueError('complete native Return send layout required')
            sends.append({'ownerId':key,'ownerName':str(owner.name),'sends':[{'returnTrackId':f'return-{j}','returnName':str(destination.name),'sendId':f'send-{j}','send':send_record(p)} for j,(destination,p) in enumerate(zip(returns,parameters))]})
            send_refs.append(parameters)
    kept_returns=[r for i,r in enumerate(returns) if i!=removed]
    owners=[*tracks,*kept_returns,song.master_track];sidechains,sidechain_refs=_sidechain_controls(owners)
    routing=_auxiliary_routing(owners)
    pre=getattr(song,'send_pre',None);pre=None if pre is None else [int(v) for v in pre]
    if pre is not None and len(pre)!=len(returns):raise ValueError('native send pre/post layout is incomplete')
    data={'filePath':str(getattr(song,'file_path','')),'owners':rows,'sends':sends,'sendPre':pre,
          'sidechains':sidechains,'routing':routing,'scenes':[_scene_record(s,i) for i,s in enumerate(scenes)],
          'musical':_song_musical_context(song,0),'recording':_transport_recording_context(song,0),'master':_set_mixer(song,0)['master']}
    binding=(song,tracks,returns,scenes,song.master_track,tuple(refs),tuple(send_refs),sidechain_refs,tuple(_parent(t) for t in tracks))
    if tuple(song.tracks)!=tracks or tuple(song.return_tracks)!=returns or tuple(song.scenes)!=scenes:raise ValueError('Return removal topology changed during read')
    return data,binding


def context(song,params,version):
    global _song
    key=params.get('returnTrackId');index=_index(song,key);data,binding=_snapshot(song,index);target_index=len(binding[1])+index
    name=data['owners'][target_index]['name']
    routes=data['routing']+data['sidechains']
    for row in data['owners'][:len(binding[1])]:
        routing=_track_state_snapshot(song,row['ownerId'],0)['routing'];routes.extend(routing[s] for s in ('input','output'))
    if any(name in (route.get('type',{}).get('id'),route.get('type',{}).get('name')) for route in routes):raise ValueError('resolve exposed routing or sidechain dependencies before Return removal')
    if _snapshot(song,index)!=(data,binding):raise ValueError('Return removal material changed during read')
    if not callable(getattr(song,'delete_return_track',None)):raise ValueError('native Return deletion is unavailable')
    if _song!=song:_song=song;_cache.clear()
    cached=_cache.get(key)
    if cached is None or cached[0]!=binding:
        if len(_cache)>=32:del _cache[next(iter(_cache))]
        cached=(binding,str(uuid.uuid4()));_cache[key]=cached
    return {'stateVersion':version,'returnTrackId':key,'setFingerprint':_set_fingerprint(song),'identityToken':cached[1],
            'target':data['owners'][target_index],
            'affectedSends':[{'ownerId':row['ownerId'],'ownerName':row['ownerName'],**row['sends'][index]} for row in data['sends']],**data}


def begin(song,params,version):
    target=params.get('target',{});key=target.get('targetId');before=context(song,{'returnTrackId':key},version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion']!=version or params.get('returnRemovalContext')!=before:raise ValueError('Return removal identity or material changed; review a fresh plan')
    if target.get('name')!=before['target']['name']:raise ValueError('Return removal target changed')
    if params.get('allowContent') is not True:raise ValueError('allowContent: true is required for the Return and all affected send lanes')
    index=_index(song,key);_,binding=_snapshot(song,index);kept=[i for i in range(len(binding[2])) if i!=index]
    operation={'before':before,'binding':binding,'index':index,'kept':kept,'target':copy.deepcopy(target),'attempted':False,'returned':False,'nativeError':None,'error':None,'lastRead':None}
    try:
        with _undo_step(song):
            if context(song,{'returnTrackId':key},version)!=before:raise ValueError('Return removal context changed before deletion')
            operation['attempted']=True;song.delete_return_track(index);operation['returned']=True
    except Exception as error:
        if not operation['attempted']:raise
        operation['nativeError']=operation['error']=(str(error) or error.__class__.__name__)[:600]
    return operation


def _receipt(operation,version):
    return {'stateVersion':version,'deleted':operation['target'],'affectedSends':operation['before']['affectedSends'],
            'deleteRequested':operation['attempted'],'nativeReturned':operation['returned'],'deletionVerified':False,'targetAbsent':None,
            'existingLayoutPreserved':False,'remainingMaterialPreserved':None,'sendDestinationsPreserved':None,'controlsPreserved':None,
            'hiddenStateBackedUp':False,'sourceFileBytesVerified':False,'readbackPending':False,'observed':None,
            'verification':{'topologyStable':False,'recordingOff':False},'error':operation['nativeError'] or operation['error'],'observationError':None}


def unobserved(operation,version,error):
    result=_receipt(operation,version);result['observationError']=(str(error) or error.__class__.__name__)[:600];return result


def _observe(song,operation,version):
    result,observed=_receipt(operation,version),None;before,binding,kept,index=operation['before'],operation['binding'],operation['kept'],operation['index']
    try:
        if song!=binding[0]:raise ValueError('Set changed before Return removal readback')
        retained=tuple(binding[2][i] for i in kept);layout=tuple(song.tracks)==binding[1] and tuple(song.return_tracks)==retained and tuple(song.scenes)==binding[3] and song.master_track==binding[4]
        result['existingLayoutPreserved']=layout;result['targetAbsent']=True if layout else None
        if not layout:raise ValueError('Return removal or remaining native topology is unconfirmed')
        count=len(binding[1]);owner_indices=list(range(count))+[count+i for i in kept]+[count+len(binding[2])]
        overrides,labels,renamed={},{},[]
        for new,old in enumerate(kept):
            previous=before['owners'][count+old]['name'];current=str(retained[new].name);prefix=chr(65+old)+'-'
            if old<26 and new<26 and previous.startswith(prefix) and current==chr(65+new)+'-'+previous[len(prefix):] and previous!=current:
                overrides[new]=previous
                if sum(row['name']==previous for row in before['owners'])==1:labels[previous]=current
                renamed.append({'sourceReturnTrackId':f'return-{old}','returnTrackId':f'return-{new}','before':previous,'after':current})
        observed,current_binding=_snapshot(song,None,overrides);stable=_snapshot(song,None,overrides)==(observed,current_binding)
        material=current_binding[5]==tuple(binding[5][i] for i in owner_indices) and current_binding[8]==binding[8] and all(row['contentSha256']==before['owners'][old]['contentSha256'] for row,old in zip(observed['owners'],owner_indices))
        def translated(value):
            if isinstance(value,dict):return {k:translated(v) for k,v in value.items()}
            if isinstance(value,list):return [translated(v) for v in value]
            return labels.get(value,value) if isinstance(value,str) else value
        expected_sends=[]
        for new,old in enumerate(owner_indices[:-1]):
            row=copy.deepcopy(before['sends'][old]);row['ownerId']=observed['sends'][new]['ownerId'];row['sends'].pop(index)
            for j,item in enumerate(row['sends']):item.update(returnTrackId=f'return-{j}',sendId=f'send-{j}')
            expected_sends.append(translated(row))
        expected_send_refs=tuple(tuple(p for j,p in enumerate(binding[6][old]) if j!=index) for old in owner_indices[:-1])
        pre=None if before['sendPre'] is None else [v for j,v in enumerate(before['sendPre']) if j!=index]
        sends=observed['sends']==expected_sends and current_binding[6]==expected_send_refs and observed['sendPre']==pre
        controls=current_binding[7]==binding[7] and observed['routing']==translated(before['routing']) and observed['sidechains']==translated(before['sidechains']) and all(observed[k]==before[k] for k in ('filePath','scenes','musical','recording','master'))
        result.update(remainingMaterialPreserved=material,sendDestinationsPreserved=sends,controlsPreserved=controls,renumberedReturnNames=renamed,
                      observed=observed,verification={'topologyStable':stable,'recordingOff':True})
        result['deletionVerified']=operation['returned'] and result['error'] is None and stable and material and sends and controls
        if not result['deletionVerified'] and result['error'] is None:result['error']='Return removal readback did not match the plan'
    except Exception as error:result['observationError']=(str(error) or error.__class__.__name__)[:600]
    return result,observed


def complete(song,operation,version):
    result,observed=_observe(song,operation,version)
    if result['deletionVerified'] and observed!=operation['lastRead']:
        result['deletionVerified']=False;result['readbackPending']=True;result['error']='native Return removal readback has not stabilized'
    operation['lastRead']=observed;return result


def remove(song,params,version):return _observe(song,begin(song,params,version),version+1)[0]
