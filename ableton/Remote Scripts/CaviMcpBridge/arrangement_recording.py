"""Bounded Arrangement input recording with native punch boundaries."""
import math
import copy
import time
import uuid

try:
    from .bridge import (_track, _track_routing, _track_midi_routing, _arrangement_clip_record,
                         _set_fingerprint, _transport_context, _transport_recording_context)
except ImportError:
    from bridge import (_track, _track_routing, _track_midi_routing, _arrangement_clip_record,
                        _set_fingerprint, _transport_context, _transport_recording_context)

_takes = {}
_identity = (None, None)
_controls_names = ('loop_start', 'loop_length', 'loop', 'punch_in', 'punch_out',
                   'arrangement_overdub', 'session_automation_record', 'tempo',
                   'signature_numerator', 'signature_denominator', 'count_in_duration')


def _controls(song, track_id):
    controls = {name: getattr(song, name) for name in _controls_names}
    controls['count_in_duration'] = int(controls['count_in_duration'])
    return {'song': controls,
            'arms': [bool(track.arm) if getattr(track, 'can_be_armed', True) else False for track in song.tracks],
            'session': [{'active': int(track.playing_slot_index) >= 0, 'override': bool(track.back_to_arranger),
                         'pending': int(track.fired_slot_index) != -1} for track in song.tracks],
            'routing': _track_routing(song, track_id, 0), 'midiRouting': _track_midi_routing(song, track_id, 0)}


def _clips(track, track_id):
    clips = list(track.arrangement_clips)
    if len(clips) > 4096:
        raise ValueError('Arrangement recording supports at most 4096 target clips')
    return [{**_arrangement_clip_record(clip, track_id, index), 'recording': bool(getattr(clip, 'is_recording', False))}
            for index, clip in enumerate(clips)]


def source(song, params, version):
    global _identity
    start, end = params.get('startBeats'), params.get('endBeats')
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end)) or \
            start < 0 or not 0 < end-start <= 512 or (end-start)*60/float(song.tempo) > 300:
        raise ValueError('recording requires increasing nonnegative beats, at most 512 beats and 300 seconds')
    if has_active():
        raise ValueError('inspect the active Arrangement take before starting another')
    if len(_takes) >= 16:
        raise ValueError('finish retained Arrangement takes before recording another')
    if int(song.count_in_duration) not in (0, 1, 2, 3):
        raise ValueError('native count-in duration is unsupported')
    _, track = _track(song, params['trackId'])
    if bool(getattr(track, 'is_foldable', False)) or not getattr(track, 'can_be_armed', True) or not bool(track.arm) or bool(track.is_frozen):
        raise ValueError('recording requires one armed unfrozen ordinary track')
    if song.is_playing or song.record_mode or song.session_record:
        raise ValueError('resolve playback and existing recording before an Arrangement take')
    if len(song.tracks) > 256:
        raise ValueError('Arrangement recording supports at most 256 tracks')
    tracks, slots = [], 0
    for candidate in song.tracks:
        armed = bool(candidate.arm) if getattr(candidate, 'can_be_armed', True) else False
        if candidate != track and armed:
            raise ValueError('resolve unrelated armed tracks before recording')
        if bool(candidate.back_to_arranger) or int(candidate.playing_slot_index) >= 0:
            raise ValueError('resolve Session playback and overrides on every track before Arrangement recording')
        clip_slots = list(candidate.clip_slots)
        slots += len(clip_slots)
        if slots > 16384:
            raise ValueError('Arrangement recording supports at most 16384 Session slots')
        if int(candidate.fired_slot_index) != -1 or any(bool(getattr(slot, 'is_triggered', False)) or
                slot.has_clip and (bool(getattr(slot.clip, 'is_triggered', False)) or bool(getattr(slot.clip, 'is_recording', False))) for slot in clip_slots):
            raise ValueError('resolve pending launches and clip recording first')
        tracks.append({'name': str(candidate.name), 'armed': armed, 'playingSlotIndex': int(candidate.playing_slot_index)})
    clips = _clips(track, params['trackId'])
    if len(clips) >= 4096:
        raise ValueError('reserve room for a recorded clip; target already has 4096 Arrangement clips')
    if any(clip['startBeats'] < end and clip['endBeats'] > start for clip in clips):
        raise ValueError('recording range overlaps existing Arrangement material; choose empty space or a new track')
    identity = (song, tuple(song.tracks), track, tuple(track.arrangement_clips))
    if _identity[0] != identity:
        _identity = (identity, str(uuid.uuid4()))
    recording = _transport_recording_context(song, version)
    recording.pop('midiCapture')
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': _identity[1],
            'trackId': params['trackId'], 'startBeats': start, 'endBeats': end, 'tracks': tracks,
            'controls': _controls(song, params['trackId']), 'transport': _transport_context(song, version),
            'recording': recording, 'arrangement': clips}


def _same_setup(record):
    song = record['song']
    return tuple(song.tracks) == record['tracks'] and record['track'] in song.tracks and \
        _controls(song, record['trackId']) == record['ownedControls'] and not bool(song.session_record)


def _owns(record):
    return _same_setup(record) and bool(record['song'].record_mode)


def _settle_stop(record, now):
    song = record['song']
    if not _same_setup(record):
        record.update(status='ownership_lost', reason='Recording setup changed while stop was pending')
    elif not song.record_mode and not song.is_playing and not bool(getattr(song, 'is_counting_in', False)):
        record['status'] = record['stopTarget']
    elif now >= record['stopDeadline']:
        record.update(status='cleanup_failed', cleanupErrors=['Native record/transport stop did not verify within three seconds'])


def _stop(record, status, reason):
    song = record['song']
    if not _same_setup(record):
        record.update(status='ownership_lost', reason='Recording controls changed; transport and arms were left untouched')
        return
    errors = []
    try:
        song.record_mode = False
    except Exception as error:
        errors.append(str(error))
    try:
        song.stop_playing()
    except Exception as error:
        errors.append(str(error))
    record.update(status='cleanup_failed' if errors else 'stopping', stopTarget=status, stopDeadline=time.monotonic()+3,
                  reason=reason, cleanupErrors=errors)
    if not errors:
        _settle_stop(record, time.monotonic())


def start(song, params, version):
    before = source(song, params, version)
    if before != params['before']:
        raise ValueError('Arrangement recording context changed after planning')
    _, track = _track(song, params['trackId'])
    key = str(uuid.uuid4())
    record = {'song': song, 'tracks': tuple(song.tracks), 'track': track, 'trackId': params['trackId'],
              'takeId': key, 'startBeats': before['startBeats'], 'endBeats': before['endBeats'],
              'before': before, 'originalClips': tuple(track.arrangement_clips), 'status': 'starting',
              'cleanupErrors': [], 'recordingRequested': False,
              'deadline': time.monotonic() + ((before['endBeats']-before['startBeats']) +
                  (0, 1, 2, 4)[int(song.count_in_duration)]*4*int(song.signature_numerator)/int(song.signature_denominator))*60/float(song.tempo) + 10}
    _takes[key] = record
    record['ownedControls'] = copy.deepcopy(before['controls'])
    record['ownedControls']['song'].update(loop=False, loop_start=before['startBeats'],
        loop_length=before['endBeats']-before['startBeats'], punch_in=True, punch_out=True,
        arrangement_overdub=False, session_automation_record=False)
    record['startDeadline'] = time.monotonic()+3
    try:
        song.loop = False
        song.loop_start = before['startBeats']
        song.loop_length = before['endBeats']-before['startBeats']
        song.punch_in = True
        song.punch_out = True
        song.arrangement_overdub = False
        song.session_automation_record = False
        song.current_song_time = before['startBeats']
        record['recordingRequested'] = True
        song.record_mode = True
        song.start_playing()
        if _owns(record) and (song.is_playing or bool(getattr(song, 'is_counting_in', False))):
            record['startObserved'] = True
            record['status'] = 'recording'
    except Exception as error:
        record['startError'], record['reason'] = str(error), str(error)
        if not record['recordingRequested']:
            record['status'] = 'start_failed'
    return read(song, {'takeId': key}, version+1)


def has_active():
    return any(record['status'] in ('starting', 'recording', 'stopping', 'cleanup_failed', 'start_unverified') for record in _takes.values())


def advance(song, now=None):
    changed = 0
    for record in _takes.values():
        if record['status'] not in ('starting', 'start_unverified', 'recording', 'stopping'):
            continue
        old = record['status']
        try:
            now_value = time.monotonic() if now is None else now
            if song != record['song']:
                record.update(status='ownership_lost', reason='Live document changed')
            elif record['status'] in ('starting', 'start_unverified'):
                if _owns(record) and (song.is_playing or bool(getattr(song, 'is_counting_in', False))):
                    record['startObserved'] = True
                    if record.get('cancelRequested') or record.get('startError'):
                        _stop(record, 'cancelled' if record.get('cancelRequested') else 'start_failed', 'Pending recording start resolved; requested stop')
                    else:
                        record['status'] = 'recording'
                elif now_value >= record['startDeadline']:
                    record.update(status='start_unverified', reason='Native start did not verify within three seconds; inspect before cancel or retry')
            elif record['status'] == 'stopping':
                _settle_stop(record, now_value)
            elif not _owns(record):
                record.update(status='ownership_lost', reason='Recording controls changed; transport and arms were left untouched')
            elif bool(getattr(song, 'is_counting_in', False)):
                if (time.monotonic() if now is None else now) >= record['deadline']:
                    _stop(record, 'interrupted', 'Count-in deadline elapsed')
            elif not song.is_playing:
                _stop(record, 'interrupted', 'Transport stopped before the end')
            elif float(song.current_song_time) >= record['endBeats']:
                _stop(record, 'stopped', 'Requested punch range ended')
            elif float(song.current_song_time) < record['startBeats']-1e-5 or (time.monotonic() if now is None else now) >= record['deadline']:
                _stop(record, 'interrupted', 'Playhead or recording deadline changed')
        except Exception as error:
            record.update(status='ownership_lost', reason=str(error))
        changed += int(record['status'] != old)
    return changed


def read(song, params, version):
    key = params.get('takeId')
    if key is None:
        return {'stateVersion': version, 'takes': [read(song, {'takeId': key}, version) for key in _takes]}
    if key not in _takes:
        raise ValueError('Arrangement take handle is unavailable; inspect retained recordings before retrying')
    record = _takes[key]
    if record['song'] != song or tuple(song.tracks) != record['tracks']:
        return {'stateVersion': version, 'takeId': key, 'status': 'ownership_lost', 'controlContext': None,
                'performanceVerified': False, 'reason': 'Live document or track identities changed'}
    clips = _clips(record['track'], record['trackId'])
    new_clips = [clip for index, clip in enumerate(clips) if record['track'].arrangement_clips[index] not in record['originalClips']]
    covered = record['startBeats']
    for clip in sorted(new_clips, key=lambda clip: clip['startBeats']):
        if clip['startBeats'] > covered+1e-5:
            break
        if clip['endBeats'] >= covered:
            covered = clip['endBeats']
    return {'stateVersion': version, 'takeId': key, 'trackId': record['trackId'], 'status': record['status'],
            'recordingRequested': record['recordingRequested'],
            'recordingVerified': record['status'] == 'recording' and bool(song.is_playing) and bool(song.record_mode) and not bool(getattr(song, 'is_counting_in', False)),
            'countingIn': bool(getattr(song, 'is_counting_in', False)),
            'cancelRequested': bool(record.get('cancelRequested', False)),
            'startBeats': record['startBeats'], 'endBeats': record['endBeats'], 'clips': new_clips,
            'rangeCovered': covered >= record['endBeats']-1e-5 and not any(clip['recording'] for clip in new_clips),
            'performanceVerified': False, 'cleanupErrors': record['cleanupErrors'], 'reason': record.get('reason'),
            'controlContext': {'controls': _controls(song, record['trackId']), 'recording': bool(song.record_mode),
                               'playing': bool(song.is_playing), 'status': record['status'],
                               'cancelRequested': bool(record.get('cancelRequested', False))}}


def finish(song, params, version):
    observed = read(song, params, version)
    if observed['controlContext'] != params['before']['controlContext'] or observed['status'] != params['before']['status']:
        raise ValueError('Arrangement take controls changed after planning')
    record = _takes[params['takeId']]
    if record['status'] in ('starting', 'recording', 'cleanup_failed', 'start_unverified'):
        if params.get('cancel') is not True:
            raise ValueError('cancel true is required to stop an active Arrangement take')
        if record['status'] in ('starting', 'start_unverified'):
            record['cancelRequested'] = True
        else:
            _stop(record, 'cancelled', 'Requested early stop; partial material retained')
        observed = read(song, params, version+1)
    if record['status'] in ('starting', 'stopping', 'cleanup_failed', 'start_unverified') or record['status'] == 'ownership_lost' and (song.record_mode or song.is_playing):
        return {**observed, 'released': False}
    del _takes[params['takeId']]
    return {**observed, 'stateVersion': version+1, 'released': True}


def shutdown(song):
    for record in _takes.values():
        if record['song'] == song and record['status'] in ('starting', 'recording'):
            try:
                _stop(record, 'interrupted', 'Bridge shutdown')
            except Exception as error:
                record.update(status='cleanup_failed', cleanupErrors=[str(error)])
