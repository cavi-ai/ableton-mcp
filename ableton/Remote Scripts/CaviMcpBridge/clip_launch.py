"""Native identity guards for Session clip launch-mode edits."""
import uuid

try:
    from .bridge import _clip_slot, _set_fingerprint
except ImportError:
    from bridge import _clip_slot, _set_fingerprint

_song = None
_identities = {}


def objects(song, params):
    track, _, slot = _clip_slot(song, params['trackId'], params['clipId'])
    if not slot.has_clip or not hasattr(slot.clip, 'launch_mode'):
        raise ValueError('Session clip launch mode is unavailable')
    return track, slot, slot.clip


def assert_owned(song, params, identity):
    try:
        current = objects(song, params)
    except (ValueError, RuntimeError) as error:
        raise ValueError('clip launch native identity changed') from error
    if current != identity:
        raise ValueError('clip launch native identity changed')
    track, slot, clip = current
    if song.is_playing or bool(getattr(song, 'is_counting_in', False)):
        raise ValueError('launch-mode edits require stopped playback')
    if song.record_mode or song.session_record or bool(getattr(clip, 'is_recording', False)) or bool(getattr(clip, 'is_overdubbing', False)):
        raise ValueError('resolve recording before changing clip launch mode')
    if bool(getattr(track, 'is_frozen', True)):
        raise ValueError('launch mode cannot be changed on a frozen track')
    if int(track.fired_slot_index) != -1 or bool(getattr(clip, 'is_triggered', False)) or bool(getattr(slot, 'is_triggered', False)):
        raise ValueError('resolve pending launches before changing clip launch mode')


def source(song, params, version):
    global _song
    identity = objects(song, params)
    assert_owned(song, params, identity)
    mode = int(identity[2].launch_mode)
    if mode not in range(4):
        raise ValueError('native clip launch mode is unavailable')
    if _song != song:
        _identities.clear()
        _song = song
    key = (params['trackId'], params['clipId'])
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song),
            'trackId': params['trackId'], 'clipId': params['clipId'],
            'identityToken': cached[1], 'launchMode': mode}
