"""Apply one Return mixer plan through the shared native mixer engine."""
import re
try:
    from . import track_mixer
except ImportError:
    import track_mixer


def _id(params):
    key = params.get('returnTrackId')
    if not isinstance(key,str) or not re.fullmatch(r'return-(?:0|[1-9][0-9]*)',key):
        raise ValueError('canonical Return Track ID required')
    return key


def context(song, params, version):
    fields = params.get('fields')
    if not isinstance(fields,list) or any(field not in ('volume','pan','mute','solo') for field in fields):
        raise ValueError('explicit Return mixer fields required')
    return track_mixer.context(song,{'trackIds':[_id(params)],'fields':fields},version)


def begin(song, params, version):
    changes = params.get('changes')
    if not isinstance(changes,dict) or not changes or not set(changes).issubset(('volume','pan','mute','solo')):
        raise ValueError('at least one valid Return mixer change required')
    return track_mixer.begin(song,{'trackId':_id(params),'changes':changes,
        'before':params.get('before'),'expectedStateVersion':params.get('expectedStateVersion')},version,allow_returns=True)


def _receipt(result):
    result['returnTrackId'] = result.pop('trackId')
    result.setdefault('return',None)
    for key in ('trackIds','volume','pan','mute','solo','sends'):result.pop(key,None)
    return result


def complete(song, operation, version):return _receipt(track_mixer.complete(song,operation,version))


def unobserved(operation, version, error):return _receipt(track_mixer.unobserved(operation,version,error))


def apply(song, params, version):return complete(song,begin(song,params,version),version+1)
