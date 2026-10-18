"""Bound native copies of tracks and complete Group subtrees."""
import copy
import re
import uuid
try:
    from .bridge import _track_state_snapshot,_device_chain_snapshot,_undo_step,_set_fingerprint,_scene_record,_track_record
    from .track_grouping import _material,_budget,_controls,_parent,_ancestors,_global,_sidechain_controls,_auxiliary_routing,_hash
    from .track_volume import volume_record
    from .track_send import send_record
    from .midi_note_removal import _flag
except ImportError:
    from bridge import _track_state_snapshot,_device_chain_snapshot,_undo_step,_set_fingerprint,_scene_record,_track_record
    from track_grouping import _material,_budget,_controls,_parent,_ancestors,_global,_sidechain_controls,_auxiliary_routing,_hash
    from track_volume import volume_record
    from track_send import send_record
    from midi_note_removal import _flag

_song=None
_cache={}


def _indices(song,key):
    if not isinstance(key,str) or not re.fullmatch(r'track-(0|[1-9][0-9]*)',key):raise ValueError('canonical trackId required')
    tracks=tuple(song.tracks);index=int(key[6:])
    if index>=len(tracks):raise ValueError('source track is unavailable')
    members=[i for i,t in enumerate(tracks) if i==index or tracks[index] in _ancestors(t,tracks)]
    if members!=list(range(index,index+len(members))):raise ValueError('Group descendants are not contiguous')
    return members


def _relative(value,key):
    if isinstance(value,list):return [_relative(v,key) for v in value]
    if isinstance(value,dict):return {k:('owner'+v[len(key):] if k=='id' and isinstance(v,str) and v.startswith(key+':') else _relative(v,key)) for k,v in value.items() if k not in ('stateVersion','trackId','clipId')}
    return value


def _mixer(owner,main=False):
    mixer=owner.mixer_device;names=['volume','panning']
    if int(getattr(mixer,'panning_mode',0))==1:names+=['left_split_stereo','right_split_stereo']
    if main:names+=['cue_volume','crossfader']
    parameters=tuple(getattr(mixer,n) for n in names)
    sends=tuple(getattr(mixer,'sends',())) if not main else ()
    return {'parameters':{n:volume_record(p) for n,p in zip(names,parameters)},'sends':[send_record(p) for p in sends]},(mixer,parameters,sends)


def _device_refs(owners,budget):
    refs=[]
    def visit(devices):
        for device in devices:
            parameters=tuple(device.parameters);budget['devices']+=1;budget['parameters']+=len(parameters)
            if budget['devices']>512 or budget['parameters']>32768:raise ValueError('track copy exceeds 512 devices or 32768 parameters')
            refs.extend((device,parameters))
            if bool(getattr(device,'can_have_chains',False)):
                for chain in [*device.chains,*getattr(device,'return_chains',())]:refs.append(chain);visit(chain.devices)
    for owner in owners:refs.append(owner);visit(owner.devices)
    return tuple(refs)


def _inventory(devices):
    return [{'name':d['name'],'className':d['className'],'parameterCount':len(d['parameters']),
             'children':[_inventory(c['devices']) for k in ('chains','returnChains') for c in d.get(k,[])]} for d in devices]


def _snapshot(song,overrides=None):
    overrides=overrides or {};tracks,returns,scenes=tuple(song.tracks),tuple(song.return_tracks),tuple(song.scenes)
    if not 1<=len(tracks)<=256 or len(returns)>64 or len(scenes)>1024:raise ValueError('track copy exceeds track, Return or scene limits')
    if any(_flag(song,n) is not False for n in ('is_playing','record_mode','session_record','is_counting_in')):raise ValueError('track copy requires stopped playback, recording and count-in')
    if any(getattr(t,'fired_slot_index',None)!=-1 for t in tracks) or any(_flag(s,'is_triggered') is not False for s in scenes):raise ValueError('resolve pending or unknown launches before track copy')
    rows,native,budget=[],[],_budget()
    for i,t in enumerate(tracks):
        key=f'track-{i}';slots=tuple(t.clip_slots);arrangement=() if bool(t.is_foldable) else tuple(t.arrangement_clips)
        for slot in slots:
            if _flag(slot,'is_triggered') is not False:raise ValueError('resolve pending slot launches before track copy')
        clips=[s.clip for s in slots if s.has_clip]+list(arrangement)
        for clip in clips:
            if any(_flag(clip,n) is not False for n in ('is_playing','is_triggered','is_recording','is_overdubbing')):raise ValueError('resolve clip playback, recording and launches before track copy')
            if bool(getattr(clip,'is_audio_clip',False)) and len(getattr(clip,'warp_markers',()))>4096:raise ValueError('track copy exceeds 4096 audio warp markers per clip')
        previous=dict(budget);digest,refs=_material(song,t,budget,overrides.get(i))
        comparable,_=_material(song,t,_budget(),overrides.get(i),include_note_ids=False)
        raw=_track_state_snapshot(song,key,0)
        for field in ('id','isGrouped','groupTrackId'):raw['track'].pop(field,None)
        if i in overrides:raw['track']['name']=overrides[i]
        raw.pop('routing');mixer,mixer_refs=_mixer(t);sidechains,sidechain_refs=_sidechain_controls([t])
        supplement=_hash([_relative(raw,key),mixer])
        rows.append({'trackId':key,'name':str(t.name),'isGroup':bool(t.is_foldable),'sessionClipCount':sum(bool(s.has_clip) for s in slots),'arrangementClipCount':len(arrangement),
                     'devices':_inventory(raw['devices']),'counts':{k:budget[k]-previous[k] for k in budget},
                     'clips':[{'location':'session','clipId':f'{key}:clip-{j}','name':str(s.clip.name)} for j,s in enumerate(slots) if s.has_clip]+
                             [{'location':'arrangement','clipId':f'{key}:arrangement-clip-{j}','name':str(c.name),'startBeats':float(c.start_time),'endBeats':float(c.end_time)} for j,c in enumerate(arrangement)],
                     'contentSha256':_hash([digest,supplement]),'copyComparableSha256':_hash([comparable,supplement]),
                     'sidechains':sidechains,'slots':[{'stop':_flag(s,'has_stop_button')} for s in slots],
                     'readiness':{'frozen':_flag(t,'is_frozen'),'implicitArm':_flag(t,'implicit_arm')}})
        native.append((refs,mixer_refs,sidechain_refs))
    auxiliaries=[*returns,song.master_track];aux_refs=_device_refs(auxiliaries,budget);aux=[]
    for i,owner in enumerate(auxiliaries):
        key=f'return-{i}' if i<len(returns) else 'master';mixer,refs=_mixer(owner,i==len(returns));aux_refs+=refs
        sidechains,side_refs=_sidechain_controls([owner]);aux_refs+=side_refs
        aux.append([_relative(_device_chain_snapshot(song,key,0),key),mixer,sidechains])
    data={'filePath':str(getattr(song,'file_path','')),'tracks':rows,'controls':_controls(song,tracks,[]),'counts':budget,
          'scenes':[_scene_record(s,i) for i,s in enumerate(scenes)],'auxiliaryStateSha256':_hash(aux),
          'auxiliaryRouting':_auxiliary_routing(auxiliaries),'globalContext':_global(song)}
    binding=(song,tracks,returns,scenes,song.master_track,tuple(native),aux_refs,tuple(_parent(t) for t in tracks))
    if tuple(song.tracks)!=tracks or tuple(song.return_tracks)!=returns or tuple(song.scenes)!=scenes:raise ValueError('track copy topology changed during read')
    return data,binding


def _flat(values):
    for value in values:
        if isinstance(value,tuple):yield from _flat(value)
        else:yield value


def context(song,params,version):
    global _song
    key=params.get('trackId');members=_indices(song,key)
    if len(song.tracks)+len(members)>256:raise ValueError('projected copy exceeds 256 tracks including Groups')
    data,binding=_snapshot(song)
    for i in members:
        t=binding[1][i]
        armed=getattr(t,'can_be_armed',True) and (_flag(t,'arm') is not False or _flag(t,'implicit_arm') is not False)
        monitoring=True
        if not bool(t.is_foldable):
            try:monitoring=int(t.current_monitoring_state) in (1,2)
            except Exception:monitoring=False
        if _flag(t,'solo') is not False or armed or not monitoring:raise ValueError('resolve explicit/implicit arming, solo and live-input or unknown monitoring before track copy')
    for k,maximum in (('slots',4096),('notes',16384),('devices',512),('parameters',32768)):
        if data['counts'][k]+sum(data['tracks'][i]['counts'][k] for i in members)>maximum:raise ValueError('projected track copy exceeds material limits')
    try:set(_flat(binding[5]))
    except TypeError:raise ValueError('native object identity comparison is unavailable for track copy')
    if _snapshot(song)!=(data,binding):raise ValueError('track copy material changed during read')
    if not callable(getattr(song,'duplicate_track',None)):raise ValueError('native track duplication is unavailable')
    if _song!=song:_song=song;_cache.clear()
    cached=_cache.get(key)
    if cached is None or cached[0]!=binding:
        if len(_cache)>=32:del _cache[next(iter(_cache))]
        cached=(binding,str(uuid.uuid4()));_cache[key]=cached
    at=members[-1]+1
    return {'stateVersion':version,'trackId':key,'setFingerprint':_set_fingerprint(song),'identityToken':cached[1],
            'sourceTracks':[data['tracks'][i] for i in members],'destinationId':f'track-{at}',
            'displaced':None if at==len(binding[1]) else _track_record(song,binding[1][at],at),**data}


def _locate(song,operation):
    original=operation['binding'][1];current=tuple(song.tracks);at,size=operation['at'],len(operation['members'])
    if len(current)!=len(original)+size or current[:at]!=original[:at] or current[at+size:]!=original[at:]:return None
    copies=current[at:at+size]
    return copies if all(t not in original for t in copies) else None


def begin(song,params,version):
    target=params.get('target',{});before=context(song,{'trackId':target.get('targetId')},version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion']!=version or params.get('trackCopyContext')!=before:raise ValueError('track copy identity or material changed; review a fresh plan')
    if target.get('sourceName')!=before['sourceTracks'][0]['name'] or target.get('destinationId')!=before['destinationId']:raise ValueError('track copy target changed')
    name=target.get('name');explicit=params.get('explicitCopyName')
    if type(explicit) is not bool:raise ValueError('explicit or inherited copy name intent required')
    if not isinstance(name,str) or explicit and (not name.strip() or len(name)>128 or any(ord(c)<32 or ord(c)==127 for c in name)):raise ValueError('explicit copy name must contain 1 to 128 characters without controls')
    if not explicit and name!=before['sourceTracks'][0]['name']:raise ValueError('inherited copy name must match the observed source label')
    members=_indices(song,target['targetId']);_,binding=_snapshot(song)
    operation={'before':before,'binding':binding,'members':members,'at':members[-1]+1,'target':copy.deepcopy(target),'attempted':False,'returned':False,'nameApplied':False,'nativeError':None,'error':None,'lastRead':None}
    try:
        with _undo_step(song):
            if context(song,{'trackId':target['targetId']},version)!=before:raise ValueError('track copy context changed before duplication')
            operation['attempted']=True;song.duplicate_track(members[0]);operation['returned']=True
            copies=_locate(song,operation)
            if copies is None:raise RuntimeError('native copy topology is unconfirmed; no track was renamed')
            copies[0].name=name;operation['nameApplied']=True
    except Exception as error:
        if not operation['attempted']:raise
        operation['nativeError']=operation['error']=(str(error) or error.__class__.__name__)[:600]
    return operation


def _receipt(operation,version):
    return {'stateVersion':version,'target':operation['target'],'duplicateRequested':operation['attempted'],'nativeReturned':operation['returned'],
            'nameApplied':operation['nameApplied'],'copiesLocated':None,'createdTracks':None,'existingLayoutPreserved':False,'originalMaterialPreserved':None,
            'copyMaterialMatches':None,'copyOwnersDistinct':None,'hierarchyVerified':None,'controlsPreserved':None,'copyVerified':False,
            'hiddenStateBackedUp':False,'sourceFileBytesVerified':False,'readbackPending':False,'observed':None,
            'verification':{'topologyStable':False,'recordingOff':False},'error':operation['nativeError'] or operation['error'],'observationError':None}


def unobserved(operation,version,error):
    result=_receipt(operation,version);result['observationError']=(str(error) or error.__class__.__name__)[:600];return result


def _observe(song,operation,version):
    result,observed=_receipt(operation,version),None;before,binding,members,at=operation['before'],operation['binding'],operation['members'],operation['at'];size=len(members)
    try:
        if song!=binding[0]:raise ValueError('Set changed before track copy readback')
        copies=_locate(song,operation);layout=copies is not None and tuple(song.return_tracks)==binding[2] and tuple(song.scenes)==binding[3] and song.master_track==binding[4]
        result['existingLayoutPreserved']=layout;result['copiesLocated']=copies is not None
        if not layout:raise ValueError('track copy or original native topology is unconfirmed')
        mapped=[i if i<at else i+size for i in range(len(binding[1]))];overrides,labels,renamed={},{},[]
        for old,new in enumerate(mapped):
            previous=before['tracks'][old]['name'];current=str(song.tracks[new].name);prefix=f'{old+1}-'
            if previous.startswith(prefix) and current==f'{new+1}-'+previous[len(prefix):] and previous!=current:
                overrides[new]=previous;renamed.append({'sourceTrackId':f'track-{old}','trackId':f'track-{new}','before':previous,'after':current})
                if sum(row['name']==previous for row in before['tracks'])==1:labels[previous]=current
        for offset,old in enumerate(members):
            new=at+offset;previous=before['tracks'][old]['name'];current=str(copies[offset].name);prefix=f'{old+1}-'
            if offset==0 or previous.startswith(prefix) and current==f'{new+1}-'+previous[len(prefix):]:overrides[new]=previous
        observed,current_binding=_snapshot(song,overrides);stable=_snapshot(song,overrides)==(observed,current_binding)
        original=current_binding[5] and all(current_binding[5][new]==binding[5][old] and observed['tracks'][new]['contentSha256']==before['tracks'][old]['contentSha256'] and observed['tracks'][new]['slots']==before['tracks'][old]['slots'] and observed['tracks'][new]['readiness']==before['tracks'][old]['readiness'] for old,new in enumerate(mapped))
        original_refs=set(_flat(binding[5]));new_refs=list(_flat(tuple(current_binding[5][at+i] for i in range(size))));distinct=all(ref not in original_refs for ref in new_refs)
        copied=all(observed['tracks'][at+i]['copyComparableSha256']==before['tracks'][old]['copyComparableSha256'] and observed['tracks'][at+i]['slots']==before['tracks'][old]['slots'] and observed['tracks'][at+i]['readiness']==before['tracks'][old]['readiness'] for i,old in enumerate(members))
        expected_parents=[binding[7][old] for old in range(len(binding[1]))];hierarchy=all(current_binding[7][new]==expected_parents[old] for old,new in enumerate(mapped))
        for offset,old in enumerate(members):
            parent=binding[7][old];parent_copy=next((copies[j] for j,source in enumerate(members) if binding[1][source]==parent),parent)
            hierarchy=hierarchy and current_binding[7][at+offset]==parent_copy
        def translated(value):
            if isinstance(value,dict):return {k:translated(v) for k,v in value.items()}
            if isinstance(value,list):return [translated(v) for v in value]
            return labels.get(value,value) if isinstance(value,str) else value
        controls=all(observed['controls'][new]==translated(before['controls'][old]) and observed['tracks'][new]['sidechains']==translated(before['tracks'][old]['sidechains']) for old,new in enumerate(mapped))
        for offset,old in enumerate(members):
            expected=translated(copy.deepcopy(before['controls'][old]));expected['name']=observed['controls'][at+offset]['name']
            controls=controls and observed['controls'][at+offset]==expected and observed['tracks'][at+offset]['sidechains']==translated(before['tracks'][old]['sidechains'])
        controls=controls and current_binding[6]==binding[6] and all(observed[k]==translated(before[k]) for k in ('filePath','scenes','auxiliaryStateSha256','auxiliaryRouting','globalContext'))
        name=str(copies[0].name)==operation['target']['name']
        result.update(originalMaterialPreserved=bool(original),copyMaterialMatches=copied,copyOwnersDistinct=distinct,hierarchyVerified=bool(hierarchy),controlsPreserved=bool(controls),
                      createdTracks=observed['tracks'][at:at+size],renumberedTrackNames=renamed,observed=observed,verification={'topologyStable':stable,'recordingOff':True})
        result['copyVerified']=operation['returned'] and operation['nameApplied'] and result['error'] is None and stable and original and copied and distinct and hierarchy and controls and name
        if not result['copyVerified'] and result['error'] is None:result['error']='track copy readback did not match the plan'
    except Exception as error:result['observationError']=(str(error) or error.__class__.__name__)[:600]
    return result,observed


def complete(song,operation,version):
    result,observed=_observe(song,operation,version)
    if result['copyVerified'] and observed!=operation['lastRead']:
        result['copyVerified']=False;result['readbackPending']=True;result['error']='native track copy readback has not stabilized'
    operation['lastRead']=observed;return result


def duplicate(song,params,version):return _observe(song,begin(song,params,version),version+1)[0]
