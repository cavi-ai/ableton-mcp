"""Guarded Session launch-entry edits without rewriting clip material."""
import copy
import math
import re
import uuid
try:
    from .bridge import _clip_slot, _set_fingerprint, _undo_step
    from .clip_duplication import _content
except ImportError:
    from bridge import _clip_slot, _set_fingerprint, _undo_step
    from clip_duplication import _content

_song = None
_identities = {}


def _flag(owner, name):
    try:
        value = getattr(owner, name)
    except Exception:
        return None
    return bool(value) if type(value) in (bool, int) and value in (0, 1) else None


def _objects(song, params):
    track_id, clip_id = params.get('trackId'), params.get('clipId')
    if not isinstance(track_id, str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)', track_id) or \
            not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id)+r':clip-(?:0|[1-9][0-9]*)', clip_id):
        raise ValueError('exact ordinary track and Session clip IDs required')
    if len(song.tracks) > 256:
        raise ValueError('Session clip entry supports at most 256 tracks')
    track, _, slot = _clip_slot(song, track_id, clip_id)
    if _flag(track, 'is_foldable') is not False or not slot.has_clip:
        raise ValueError('Session clip entry requires a populated ordinary track slot')
    return song, tuple(song.tracks), track, slot, slot.clip


def _controls(identity):
    song, _, track, slot, clip = identity
    result = {'playing': _flag(song, 'is_playing'), 'recording': _flag(song, 'record_mode'),
              'sessionRecord': _flag(song, 'session_record'), 'countingIn': _flag(song, 'is_counting_in'),
              'frozen': _flag(track, 'is_frozen'), 'armed': _flag(track, 'arm'),
              'implicitArm': _flag(track, 'implicit_arm'), 'clipPlaying': _flag(clip, 'is_playing'),
              'clipRecording': _flag(clip, 'is_recording'), 'overdubbing': _flag(clip, 'is_overdubbing'),
              'clipTriggered': _flag(clip, 'is_triggered'), 'slotTriggered': _flag(slot, 'is_triggered')}
    fired = getattr(track, 'fired_slot_index', None)
    if result['playing'] is None or any(v is not False for k, v in result.items() if k != 'playing') or \
            type(fired) is not int or fired != -1:
        raise ValueError('entry edits require an inactive, unarmed, unfrozen target, recording/count-in off and no pending launches; unknown controls refuse')
    return result


def context(song, params, version):
    global _song
    identity = _objects(song, params)
    controls = _controls(identity)
    if _flag(identity[-1], 'is_audio_clip') is None:
        raise ValueError('native clip type unavailable')
    content = _content(song, params['trackId'], params['clipId'], version)
    markers = content['timing']['markers']
    if markers.get('supported') is not True or markers.get('unit') not in ('beats', 'seconds'):
        raise ValueError('native playback markers unavailable')
    unit = markers['unit']
    start, end = markers['startBeats' if unit == 'beats' else 'startSeconds'], markers['endBeats' if unit == 'beats' else 'endSeconds']
    entry_property = 'start_marker'
    if unit == 'seconds':
        if content['timing']['loop']['enabled'] is not False:
            raise ValueError('unwarped Session entry requires native nonlooped playback')
        entry_property = 'loop_start'
        start, end = identity[-1].loop_start, identity[-1].loop_end
    if not all(type(v) in (int, float) and math.isfinite(v) for v in (start, end)) or start >= end:
        raise ValueError('native playback marker interval unavailable')
    if _objects(song, params) != identity or _controls(identity) != controls:
        raise ValueError('Session clip entry identity or controls changed during read')
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
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song),
            'trackId': params['trackId'], 'clipId': params['clipId'], 'identityToken': cached[1],
            'unit': unit, 'start': start, 'end': end, 'entryProperty': entry_property,
            'controls': controls, 'content': content}


def set_start(song, params, version):
    start = params.get('start')
    if type(start) not in (int, float) or not math.isfinite(start):
        raise ValueError('start requires a finite native marker position')
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('Session clip entry identity or content changed; review a fresh plan')
    if params.get('unit') != before['unit'] or start >= before['end'] or (before['unit'] == 'seconds' and start < 0):
        raise ValueError('start requires the observed unit and a position before the retained end; seconds must be nonnegative')
    identity = _objects(song, params)
    expected = copy.deepcopy(before['content'])
    key = 'startBeats' if before['unit'] == 'beats' else 'startSeconds'
    if start != before['start']:
        expected['timing']['markers'][key] = start
        if 'audio' in expected:
            expected['audio']['markers'][key] = start
            if before['unit'] == 'seconds':
                expected['timing']['loop'][key] = start
                expected['audio']['loop'][key] = start
    attempted, returned, error = False, False, None
    try:
        if start != before['start']:
            with _undo_step(song):
                if context(song, params, version) != before or _objects(song, params) != identity:
                    raise ValueError('Session clip entry changed at undo entry')
                attempted = True
                setattr(identity[-1], before['entryProperty'], start)
                returned = True
    except Exception as failure:
        if not attempted:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {'stateVersion': version+1, 'writeRequested': attempted, 'nativeReturned': returned,
              'verified': False, 'targetRetained': False, 'observed': None, 'error': error}
    try:
        after = context(song, params, version+1)
        retained = _objects(song, params) == identity and after['identityToken'] == before['identityToken']
        preserved = after['content'] == expected and after['controls'] == before['controls']
        verified = error is None and (not attempted or returned) and retained and preserved and after['start'] == start
        return {**result, 'verified': verified, 'targetRetained': retained, 'retainedStateVerified': preserved,
                'observed': after, 'error': error if verified or error else 'entry marker or retained material readback differs; inspect before continuing'}
    except Exception as failure:
        return {**result, 'observationError': (str(failure) or failure.__class__.__name__)[:600]}
