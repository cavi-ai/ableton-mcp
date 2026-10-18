"""Bind one audio clip before native Clip View reversal."""
import os
import uuid
try:
    from .bridge import _track, _audio_clip, _audio_clip_state, _clip_timing, _set_fingerprint
    from .midi_export import _track_ui_path
except ImportError:
    from bridge import _track, _audio_clip, _audio_clip_state, _clip_timing, _set_fingerprint
    from midi_export import _track_ui_path

_song = None
_identities = {}
_owners = {}


def _off(obj, field):
    value = getattr(obj, field, None)
    if type(value) not in (bool, int) or value != 0:
        raise ValueError('audio reversal requires known stopped/unarmed/unfrozen state: ' + field)


def source(song, params, version):
    global _song
    _, track = _track(song, params['trackId'])
    clip, timeline = _audio_clip(song, params['trackId'], params['clipId'])
    for field in ('is_playing','record_mode','session_record','is_counting_in'): _off(song,field)
    for field in ('is_frozen','arm'): _off(track,field)
    for field in ('is_recording','is_triggered'): _off(clip,field)
    if len(song.tracks) > 256: raise ValueError('audio reversal supports at most 256 tracks')
    all_clips = []
    positions = 0
    for owner in song.tracks:
        if int(getattr(owner,'fired_slot_index',-2)) != -1: raise ValueError('resolve pending launches before audio reversal')
        arrangement = () if getattr(owner,'is_foldable',False) else owner.arrangement_clips
        if len(owner.clip_slots) > 512 or len(arrangement) > 4096:
            raise ValueError('audio reversal clip inventory exceeds bounds')
        positions += len(owner.clip_slots) + len(arrangement)
        if positions > 8192:
            raise ValueError('audio reversal supports at most 8192 inventoried clip positions')
        all_clips.extend(slot.clip for slot in owner.clip_slots if slot.has_clip)
        all_clips.extend(arrangement)
    if not clip.name or sum(item.name == clip.name for item in all_clips) != 1:
        raise ValueError('audio reversal requires a unique nonempty clip name')
    if not os.path.isabs(str(getattr(song,'file_path',''))) or not os.path.isabs(str(clip.file_path)):
        raise ValueError('audio reversal requires a saved Set and local source file')
    if len(getattr(clip,'warp_markers',())) > 4096: raise ValueError('audio reversal supports at most 4096 warp markers')
    if _song != song:
        _song = song
        _identities.clear()
        _owners.clear()
    identity = (song,tuple(song.tracks),track,tuple(track.arrangement_clips) if timeline is not None else tuple(track.clip_slots),clip)
    key = params['trackId'],params['clipId']
    if timeline is None:
        owner_identity = (song,tuple(song.tracks),track,tuple(track.clip_slots))
    else:
        index = int(params['clipId'].rsplit('-',1)[1])
        owner_identity = (song,tuple(song.tracks),track,
                          tuple(None if i == index else item for i,item in enumerate(track.arrangement_clips)),
                          timeline['startBeats'],timeline['endBeats'])
    if key not in _owners or _owners[key][0] != owner_identity:
        if len(_owners) >= 64: _owners.pop(next(iter(_owners)))
        _owners[key] = owner_identity,str(uuid.uuid4())
    if key not in _identities or _identities[key][0] != identity:
        if len(_identities) >= 64: _identities.pop(next(iter(_identities)))
        _identities[key] = identity,str(uuid.uuid4())
    timing = _clip_timing(song,params['trackId'],params['clipId'],version)
    # Live's adaptive editor grid can change asynchronously when Clip View opens.
    # It does not affect source reversal, musical markers or playback controls.
    timing.pop('editorGrid',None)
    return {'stateVersion':version,'setFingerprint':_set_fingerprint(song),'identityToken':_identities[key][1],
            'ownerIdentityToken':_owners[key][1],
            'filePath':song.file_path,'scriptDirectory':os.path.dirname(__file__),
            'trackId':params['trackId'],'trackName':track.name,'trackUIPath':_track_ui_path(song,track),
            'clipId':params['clipId'],'name':clip.name,'location':'arrangement' if timeline is not None else 'session',
            'audio':_audio_clip_state(song,params['trackId'],params['clipId'],version),
            'timing':timing,
            'hasEnvelopes':getattr(clip,'has_envelopes',None), 'muted':getattr(clip,'muted',None)}


def select(song, params, version, application):
    before = source(song,params,version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('audio reversal source or native identity changed before selection')
    if application is None: raise ValueError('native audio reversal view selection unavailable')
    _, track = _track(song,params['trackId'])
    clip,timeline = _audio_clip(song,params['trackId'],params['clipId'])
    song.view.selected_track = track
    song.view.detail_clip = clip
    if timeline is None: song.view.selected_scene = song.scenes[int(params['clipId'].split(':clip-')[1])]
    application.view.show_view('Arranger' if timeline is not None else 'Session')
    application.view.show_view('Detail')
    application.view.show_view('Detail/Clip')
    if callable(getattr(clip.view,'hide_envelope',None)): clip.view.hide_envelope()
    application.view.focus_view('Detail/Clip')
    if song.view.detail_clip != clip or song.view.selected_track != track: raise RuntimeError('audio reversal selection did not verify')
    return {'stateVersion':version+1,'source':source(song,params,version+1)}
