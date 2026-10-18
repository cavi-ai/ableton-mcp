"""Native identity and scope guards for clip activation edits."""
import re
import uuid
try:
    from .bridge import _track, _clip_slot, _clip_reference, _set_fingerprint
except ImportError:
    from bridge import _track, _clip_slot, _clip_reference, _set_fingerprint

_song = None
_identities = {}


def _flag(owner, name):
    try:
        value = getattr(owner, name)
    except Exception:
        return None
    return bool(value) if type(value) in (bool, int) and value in (0, 1) else None


def objects(song, params):
    track_id, clip_id = params.get('trackId'), params.get('clipId')
    if not isinstance(track_id, str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)', track_id):
        raise ValueError('clip mute requires a canonical ordinary track ID')
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id)+r':(?:arrangement-)?clip-(?:0|[1-9][0-9]*)', clip_id):
        raise ValueError('clip mute requires an exact Session or Arrangement clip ID')
    if len(song.tracks) > 256:
        raise ValueError('clip mute supports at most 256 tracks')
    _, owner = _track(song, track_id)
    if bool(getattr(owner, 'is_foldable', False)):
        raise ValueError('clip mute requires an ordinary track')
    clip, timeline = _clip_reference(song, track_id, clip_id)
    slot = None if timeline is not None else _clip_slot(song, track_id, clip_id)[2]
    return song, tuple(song.tracks), owner, slot, clip


def controls(identity):
    song, _, track, slot, clip = identity
    result = {'playing': _flag(song, 'is_playing'), 'recording': _flag(song, 'record_mode'),
              'sessionRecord': _flag(song, 'session_record'), 'countingIn': _flag(song, 'is_counting_in'),
              'frozen': _flag(track, 'is_frozen'), 'armed': _flag(track, 'arm'),
              'implicitArm': _flag(track, 'implicit_arm'), 'clipRecording': _flag(clip, 'is_recording'),
              'overdubbing': _flag(clip, 'is_overdubbing'), 'clipTriggered': _flag(clip, 'is_triggered'),
              'slotTriggered': False if slot is None else _flag(slot, 'is_triggered')}
    if result['playing'] is None or any(value is not False for key, value in result.items() if key != 'playing') or \
            type(track.fired_slot_index) is not int or track.fired_slot_index != -1:
        raise ValueError('resolve recording, count-in, frozen/armed tracks and pending launches before clip mute; unknown flags refuse')
    return result


def assert_owned(song, params, identity, expected_controls, expected_mute):
    if objects(song, params) != identity:
        raise ValueError('clip mute native identity changed')
    if controls(identity) != expected_controls or _flag(identity[-1], 'muted') is not expected_mute:
        raise ValueError('clip mute context or native readback changed')


def source(song, params, version):
    global _song
    identity = objects(song, params)
    state = controls(identity)
    muted = _flag(identity[-1], 'muted')
    if muted is None:
        raise ValueError('native clip mute is unavailable')
    if _song != song:
        _song = song
        _identities.clear()
    key = params['trackId'], params['clipId']
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = identity, str(uuid.uuid4())
        _identities[key] = cached
    assert_owned(song, params, identity, state, muted)
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song),
            'trackId': params['trackId'], 'clipId': params['clipId'], 'identityToken': cached[1],
            'muted': muted, 'controls': state}
