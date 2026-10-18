"""Rename one exact Arrangement clip without changing musical controls."""
import re
import uuid
try:
    from .bridge import _track, _clip_reference, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _track, _clip_reference, _set_fingerprint, _undo_step

_song=None
_identities={}


def _objects(song,params):
    track_id,clip_id=params.get('trackId'),params.get('clipId')
    if not isinstance(track_id,str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)',track_id):
        raise ValueError('canonical ordinary track ID required')
    if not isinstance(clip_id,str) or not re.fullmatch(re.escape(track_id)+r':arrangement-clip-(?:0|[1-9][0-9]*)',clip_id):
        raise ValueError('exact Arrangement clip ID required')
    if len(song.tracks)>256:raise ValueError('clip names support at most 256 tracks')
    _,owner=_track(song,track_id)
    if getattr(owner,'is_foldable',False):raise ValueError('Arrangement clip names require an ordinary track')
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
    if _objects(song,params)[2]!=binding:raise ValueError('native Arrangement clip changed during read')
    return {'stateVersion':version,'setFingerprint':_set_fingerprint(song),'identityToken':cached[1],
            'trackId':params['trackId'],'clipId':params['clipId'],'trackName':binding[2].name,'clip':timeline}


def rename(song,params,version):
    name=params.get('name')
    if not isinstance(name,str) or not name.strip() or len(name)>128 or any(ord(c)<32 or ord(c)==127 for c in name):
        raise ValueError('name requires 1 to 128 characters without control characters')
    before=context(song,params,version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion']!=version or before!=params.get('before'):
        raise ValueError('Arrangement clip identity, interval or name changed; review a fresh plan')
    clip,_,binding=_objects(song,params)
    attempted,returned,error=False,False,None
    try:
        if name!=before['clip']['name']:
            with _undo_step(song):
                if context(song,params,version)!=before or _objects(song,params)[2]!=binding:
                    raise ValueError('Arrangement clip changed before name write')
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
        return {**result,'verified':verified,'targetRetained':retained,'intervalPreserved':same_interval,'observed':after,
                'error':error if verified or error else 'Arrangement clip name readback did not match the plan'}
    except Exception as failure:
        return {**result,'observationError':(str(failure) or failure.__class__.__name__)[:600]}
