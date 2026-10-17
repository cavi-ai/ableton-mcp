"""Bounded Session launch-button requests advanced on Live display ticks."""
import math
import time
import uuid

try:
    from .bridge import _clip_timing, _enum_record, _set_fingerprint, SONG_QUANTIZATION_NAMES
    from .clip_launch import objects
except ImportError:
    from bridge import _clip_timing, _enum_record, _set_fingerprint, SONG_QUANTIZATION_NAMES
    from clip_launch import objects

_holds = {}
_sources = {}
_source_song = None


def _record(key):
    if not isinstance(key, str) or key not in _holds:
        raise ValueError('clip hold handle is unavailable; inspect current clips before retrying')
    return _holds[key]


def _location(record, song):
    if record['song'] != song:
        return None
    try:
        tracks = song.tracks
        ti = record['trackIndex']
        if ti >= len(tracks) or tracks[ti] != record['track']:
            ti = next((i for i, track in enumerate(tracks) if track == record['track']), None)
        if ti is None:
            return None
        slots, si = record['track'].clip_slots, record['slotIndex']
        if si >= len(slots) or slots[si] != record['slot']:
            si = next((i for i, slot in enumerate(slots) if slot == record['slot']), None)
        if si is None or not record['slot'].has_clip or record['slot'].clip != record['clip']:
            return None
        record.update(trackIndex=ti, slotIndex=si)
        return f'track-{ti}', f'track-{ti}:clip-{si}'
    except Exception:
        return None


def _flag(clip, name):
    try:
        return bool(getattr(clip, name))
    except Exception:
        return None


def source(song, params, version):
    global _source_song
    if 'holdId' in params:
        record = _record(params['holdId'])
        location = _location(record, song)
        return {'stateVersion': version, 'holdId': params['holdId'], 'identityToken': params['holdId'],
                'status': record['status'], 'releaseAttempts': record['releaseAttempts'],
                'setFingerprint': record['setFingerprint'], 'sourceSetMatches': record['song'] == song,
                'trackId': location[0] if location else None, 'clipId': location[1] if location else None}
    allow_playing = params.get('allowPlaying', False)
    if type(allow_playing) is not bool:
        raise ValueError('allowPlaying must be boolean')
    track, slot, clip = identity = objects(song, params)
    if not callable(getattr(clip, 'set_fire_button_state', None)) or any(not hasattr(clip, key) for key in
            ('is_playing', 'is_triggered', 'is_recording', 'is_overdubbing')):
        raise ValueError('native Session clip held-button support is unavailable')
    if any(r['track'] == track and r['status'] in ('active', 'cleanup_failed') for r in _holds.values()):
        raise ValueError('this track already has an active hold or unresolved release')
    if not song.is_playing or bool(getattr(song, 'is_counting_in', False)):
        raise ValueError('start authorized global playback before holding a Session clip')
    if song.record_mode or song.session_record or clip.is_recording or clip.is_overdubbing:
        raise ValueError('resolve recording before holding a Session clip')
    if track.arm or track.is_frozen:
        raise ValueError('clip holds require an unarmed, unfrozen track')
    if int(clip.launch_mode) not in (1, 3):
        raise ValueError('configure Gate or Repeat before holding a Session clip')
    if int(track.fired_slot_index) != -1 or clip.is_triggered or bool(getattr(slot, 'is_triggered', False)):
        raise ValueError('resolve pending track launches before holding a Session clip')
    index = int(params['clipId'].rsplit('-', 1)[1])
    # Live reports -2 after a Session Clip Stop, including Gate release.
    if int(track.playing_slot_index) not in (-2, -1, index):
        raise ValueError('another Session clip is playing on this track')
    if clip.is_playing and not allow_playing:
        raise ValueError('the target is already playing; allowPlaying requires explicit scope')
    if len(song.tracks) > 256 or len(track.clip_slots) > 1024:
        raise ValueError('clip holds support at most 256 tracks and 1024 slots per track')
    if _source_song != song:
        _sources.clear()
        _source_song = song
    key = (params['trackId'], params['clipId'])
    cached = _sources.get(key)
    if cached is None or cached[0] != identity:
        if key not in _sources and len(_sources) >= 64:
            del _sources[next(iter(_sources))]
        cached = (identity, str(uuid.uuid4()))
        _sources[key] = cached
    timing = _clip_timing(song, params['trackId'], params['clipId'], version)
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': cached[1],
            'trackId': params['trackId'], 'clipId': params['clipId'], 'allowPlaying': allow_playing,
            'clip': {'name': clip.name, 'launchMode': timing['launchMode'],
                     'launchQuantization': timing['launchQuantization'], 'launchLegato': timing['launchLegato'],
                     'loop': timing['loop'], 'markers': timing['markers'], 'isPlaying': bool(clip.is_playing)},
            'track': {'name': track.name, 'mute': bool(track.mute), 'solo': bool(track.solo),
                      'arrangementOverride': getattr(track, 'back_to_arranger', None)},
            'globalLaunchQuantization': _enum_record(song.clip_trigger_quantization, SONG_QUANTIZATION_NAMES)}


def _release(record, status, reason, now=None):
    record.update(releaseRequested=True, releaseCallReturned=False, releaseAttempts=record['releaseAttempts'] + 1,
                  reason=reason, elapsedSeconds=max(0, (time.monotonic() if now is None else now) - record['started']),
                  cleanupErrors=[])
    try:
        # Release the retained clip, never a replacement found at its old ID.
        record['clip'].set_fire_button_state(False)
        record.update(releaseCallReturned=True, status=status)
    except Exception as error:
        record.update(status='cleanup_failed', cleanupErrors=[str(error) or error.__class__.__name__])


def has_active():
    return any(record['status'] == 'active' for record in _holds.values())


def advance(song, now=None):
    now = time.monotonic() if now is None else now
    changed = 0
    for record in list(_holds.values()):
        if record['status'] != 'active':
            continue
        reason = None
        try:
            if _location(record, song) is None:
                reason = 'source Set, track, slot or clip ownership changed'
            elif not song.is_playing or song.record_mode or song.session_record or record['track'].arm:
                reason = 'global playback, recording or source arm state changed'
            elif int(record['clip'].launch_mode) != record['mode']:
                reason = 'clip launch mode changed'
        except Exception as error:
            reason = str(error) or error.__class__.__name__
        if reason is not None or now >= record['deadline']:
            _release(record, 'interrupted' if reason else 'complete', reason or 'requested hold duration elapsed', now)
            changed += 1
    return changed


def shutdown(song):
    for record in list(_holds.values()):
        if record['status'] == 'active':
            _release(record, 'interrupted', 'bridge disconnected')


def read(song, params, version):
    if 'holdId' not in params:
        return {'stateVersion': version, 'holds': [read(song, {'holdId': key}, version) for key in _holds]}
    record = _record(params['holdId'])
    location = _location(record, song)
    return {'stateVersion': version, 'holdId': params['holdId'], 'setFingerprint': record['setFingerprint'],
            'sourceSetMatches': record['song'] == song, 'trackId': location[0] if location else None,
            'clipId': location[1] if location else None, 'name': record['name'], 'status': record['status'],
            'mode': 'gate' if record['mode'] == 1 else 'repeat', 'durationSeconds': record['duration'],
            'elapsedSeconds': record.get('elapsedSeconds'), 'pressCallReturned': record['pressCallReturned'],
            'releaseRequested': record['releaseRequested'], 'releaseCallReturned': record['releaseCallReturned'],
            'releaseAttempts': record['releaseAttempts'], 'buttonStateVerified': False,
            'isPlaying': _flag(record['clip'], 'is_playing'), 'isTriggered': _flag(record['clip'], 'is_triggered'),
            'reason': record.get('reason'), 'cleanupErrors': list(record['cleanupErrors']),
            'timingBasis': 'wall-clock duration on Live display ticks; not beat-scheduled or a hard real-time bound'}


def start(song, params, version):
    duration = params.get('durationSeconds')
    if type(duration) not in (int, float) or not math.isfinite(duration) or not .25 <= duration <= 8:
        raise ValueError('hold duration must be between 0.25 and 8 seconds')
    if params.get('expectedStateVersion') != version or source(song, params, version) != params.get('before'):
        raise ValueError('clip hold identity, launch context or state changed')
    if len(_holds) >= 16 or sum(r['status'] == 'active' for r in _holds.values()) >= 4:
        raise ValueError('finish retained clip holds; at most 16 handles and four active holds are supported')
    track, slot, clip = objects(song, params)
    key, now = str(uuid.uuid4()), time.monotonic()
    record = {'song': song, 'track': track, 'slot': slot, 'clip': clip, 'name': clip.name,
              'trackIndex': int(params['trackId'][6:]), 'slotIndex': int(params['clipId'].rsplit('-', 1)[1]),
              'mode': int(clip.launch_mode), 'setFingerprint': _set_fingerprint(song), 'status': 'active',
              'duration': duration, 'started': now, 'deadline': now + duration, 'pressCallReturned': False,
              'releaseRequested': False, 'releaseCallReturned': False, 'releaseAttempts': 0, 'cleanupErrors': []}
    _holds[key] = record
    try:
        clip.set_fire_button_state(True)
        record['pressCallReturned'] = True
    except Exception as error:
        _release(record, 'failed', str(error))
        raise RuntimeError(f'clip hold press failed; inspect hold {key}: {error}; cleanup: {record["cleanupErrors"]}') from error
    if _location(record, song) is None:
        _release(record, 'interrupted', 'clip ownership changed during the press')
    return read(song, {'holdId': key}, version + 1)


def finish(song, params, version):
    if params.get('expectedStateVersion') != version or source(song, params, version) != params.get('before'):
        raise ValueError('clip hold handle or state changed; read before retrying')
    if type(params.get('cancel', False)) is not bool:
        raise ValueError('cancel must be boolean')
    record = _record(params['holdId'])
    if record['status'] == 'active' and not params.get('cancel', False):
        raise ValueError('hold is active; cancel explicitly to release early')
    if record['status'] == 'cleanup_failed' and not params.get('cancel', False):
        raise ValueError('failed release retains track ownership; cancel explicitly to retry release')
    if params.get('cancel', False) and record['status'] in ('active', 'cleanup_failed'):
        _release(record, 'cancelled', 'explicit release requested')
        if not record['releaseCallReturned']:
            raise RuntimeError(f'clip hold release failed; retain hold {params["holdId"]}: {record["cleanupErrors"]}')
    result = {**read(song, params, version + 1), 'handleReleased': True}
    del _holds[params['holdId']]
    return result
