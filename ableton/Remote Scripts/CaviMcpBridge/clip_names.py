"""Rename one exact Session or Arrangement clip without musical writes."""
import re
import uuid
try:
    from .bridge import _track, _clip_slot, _clip_reference, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _track, _clip_slot, _clip_reference, _set_fingerprint, _undo_step

_song=None
_identities={}


def _objects(song,params):
    track_id,clip_id=params.get('trackId'),params.get('clipId')
    location=params.get('location','arrangement')
    if location not in ('session','arrangement'):raise ValueError('exact clip location required')
    if not isinstance(track_id,str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)',track_id):
        raise ValueError('canonical ordinary track ID required')
    prefix=':clip-' if location=='session' else ':arrangement-clip-'
    if not isinstance(clip_id,str) or not re.fullmatch(re.escape(track_id+prefix)+r'(?:0|[1-9][0-9]*)',clip_id):
        raise ValueError('exact clip ID for the requested location required')
    if len(song.tracks)>256:raise ValueError('clip names support at most 256 tracks')
    _,owner=_track(song,track_id)
    if getattr(owner,'is_foldable',False):raise ValueError('clip names require an ordinary track')
    if location=='session':
        if len(owner.clip_slots)>4096 or len(song.scenes)>4096:raise ValueError('clip names support at most 4096 slots and scenes')
        _,index,slot=_clip_slot(song,track_id,clip_id)
        if not slot.has_clip:raise ValueError('empty clip slot')
        if index>=len(song.scenes):raise ValueError('Session scene is unavailable')
        clip=slot.clip
        # Runtime length, recording and playback fields do not belong to a label guard.
        record={'id':clip_id,'hasClip':True,'name':clip.name}
        return clip,record,(song,tuple(song.tracks),owner,tuple(owner.clip_slots),tuple(song.scenes),clip)
    if len(owner.arrangement_clips)>4096:raise ValueError('clip names support at most 4096 clips on the target track')
    clip,timeline=_clip_reference(song,track_id,clip_id)
    return clip,timeline,(song,tuple(song.tracks),owner,tuple(owner.arrangement_clips))


def context(song,params,version):
    global _song
    clip,timeline,binding=_objects(song,params)
    if _song!=song:
        _song=song
        _identities.clear()
    key=params['trackId'],params['clipId']
    cached=_identities.get(key)
    if cached is None or cached[0]!=binding:
        if len(_identities)>=64:_identities.pop(next(iter(_identities)))
        cached=binding,str(uuid.uuid4())
        _identities[key]=cached
    if _objects(song,params)[2]!=binding:raise ValueError('native clip changed during read')
    return {'stateVersion':version,'setFingerprint':_set_fingerprint(song),'identityToken':cached[1],
            'trackId':params['trackId'],'clipId':params['clipId'],'trackName':binding[2].name,'clip':timeline}


def rename(song,params,version):
    name=params.get('name')
    session=params.get('location')=='session'
    limit=255 if session else 128
    if not isinstance(name,str) or not name.strip() or len(name)>limit or any(ord(c)<32 or ord(c)==127 for c in name):
        raise ValueError('name requires 1 to %d characters without control characters'%limit)
    before=context(song,params,version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion']!=version or before!=params.get('before'):
        raise ValueError('clip identity, label context or name changed; review a fresh plan')
    clip,_,binding=_objects(song,params)
    attempted,returned,error=False,False,None
    try:
        if name!=before['clip']['name']:
            with _undo_step(song):
                if context(song,params,version)!=before or _objects(song,params)[2]!=binding:
                    raise ValueError('clip changed before name write')
                attempted=True
                clip.name=name
                returned=True
    except Exception as failure:
        if not attempted:raise
        error=(str(failure) or failure.__class__.__name__)[:600]
    result={'stateVersion':version+1,'writeRequested':attempted,'nativeReturned':returned,'verified':False,
            'targetRetained':False,'observed':None,'error':error}
    try:
        after=context(song,params,version+1)
        retained=_objects(song,params)[2]==binding
        same_interval={k:v for k,v in after['clip'].items() if k!='name'}=={k:v for k,v in before['clip'].items() if k!='name'}
        verified=error is None and (not attempted or returned) and retained and same_interval and after['clip']['name']==name
        return {**result,'verified':verified,'targetRetained':retained,
                ('slotPreserved' if session else 'intervalPreserved'):same_interval,'observed':after,
                'error':error if verified or error else 'clip name readback did not match the plan'}
    except Exception as failure:
        return {**result,'observationError':(str(failure) or failure.__class__.__name__)[:600]}
