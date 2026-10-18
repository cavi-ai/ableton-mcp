"""Record Session clip choices into an empty Arrangement tail."""
import math
import time
import uuid

try:
    from .bridge import _arrangement_clip_record, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _arrangement_clip_record, _set_fingerprint, _undo_step

_recordings = {}
_identity = None
_token = None
_active = ('starting', 'recording', 'stopping', 'start_unverified', 'cleanup_failed')


def _controls(song):
    return {'loop': bool(song.loop), 'punchIn': bool(song.punch_in), 'punchOut': bool(song.punch_out),
            'startMarkerBeats': float(song.start_time),
            'launchQuantization': int(song.clip_trigger_quantization),
            'arrangementOverdub': bool(song.arrangement_overdub),
            'automationArm': bool(song.session_automation_record), 'countIn': int(song.count_in_duration),
            'sessionRecord': bool(song.session_record),
            'tracks': [{'armed': bool(t.arm) if not t.is_foldable and t.can_be_armed else False,
                        'implicitArm': bool(getattr(t, 'implicit_arm', False)) if not t.is_foldable else False,
                        'frozen': bool(t.is_frozen)} for t in song.tracks]}


def _inventory(song):
    result, objects = [], []
    for i, track in enumerate(song.tracks):
        if track.is_foldable:
            continue
        for j, clip in enumerate(track.arrangement_clips):
            if len(result) >= 8192:
                raise ValueError('Session Arrangement recording supports at most 8192 Arrangement clips')
            result.append(_arrangement_clip_record(clip, f'track-{i}', j))
            objects.append((track, clip))
    return result, tuple(objects)


def _bar_position(song):
    position = song.get_current_beats_song_time()
    return {name: float(getattr(position, name)) for name in ('bars', 'beats', 'sub_division', 'ticks')}


def source(song, params, version):
    global _identity, _token
    if not callable(getattr(song, 'start_playing', None)):
        raise ValueError('native start_playing is required to record from the prepared insert marker')
    start, end = params.get('startBeats'), params.get('endBeats')
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in (start, end)) or \
            start < 0 or not 0 < end-start <= 512 or (end-start)*60/float(song.tempo) > 300:
        raise ValueError('Session recording requires increasing nonnegative beats, at most 512 beats and 300 seconds at current tempo')
    if has_active() or len(_recordings) >= 16:
        raise ValueError('finish retained or active Session Arrangement recordings before starting another')
    if len(song.tracks) > 256 or sum(len(t.clip_slots) for t in song.tracks) > 16384:
        raise ValueError('Session Arrangement recording supports at most 256 tracks and 16384 Session slots')
    if song.is_playing or song.record_mode or song.is_counting_in:
        raise ValueError('resolve playback and recording before Session Arrangement recording')
    controls = _controls(song)
    if any(controls[k] for k in ('loop', 'punchIn', 'punchOut', 'automationArm', 'sessionRecord')) or controls['countIn'] not in (0, 1, 2, 3):
        raise ValueError('prepare loop, punch, automation arm and Session recording off; native count-in must be supported')
    if any(t['armed'] or t['implicitArm'] for t in controls['tracks']):
        raise ValueError('all explicit and implicit track arms must be off; this records Session clip choices, not input')
    if abs(float(song.current_song_time)-start) > 1e-5:
        raise ValueError('seek to the exact requested start while stopped and verify it before recording')
    position = _bar_position(song)
    quantization = controls['launchQuantization']
    grid_bars = {1: 8, 2: 4, 3: 2}.get(quantization, 1)
    if quantization not in range(15) or not all(math.isfinite(v) for v in position.values()) or \
            position['bars'] < 1 or position['bars'] % 1 or position['beats'] != 1 or \
            position['sub_division'] != 1 or position['ticks'] != 1 or (position['bars']-1) % grid_bars:
        raise ValueError('choose a native bar start aligned with the global launch grid; inspect the stopped bar position')
    if any(bool(getattr(s, 'is_triggered', False)) for s in song.scenes):
        raise ValueError('resolve pending scene launches before recording')
    session, refs = [], [song, tuple(song.tracks), tuple(song.scenes)]
    for i, track in enumerate(song.tracks):
        if not track.is_foldable and int(track.fired_slot_index) != -1:
            raise ValueError('resolve pending Session launches/stops before recording')
        refs.append(tuple((slot, slot.clip if slot.has_clip else None) for slot in track.clip_slots))
        clips = []
        for j, slot in enumerate(track.clip_slots):
            if bool(getattr(slot, 'is_triggered', False)) or slot.has_clip and (slot.clip.is_recording or slot.clip.is_triggered):
                raise ValueError('resolve pending launches and clip recording before recording')
            if slot.has_clip:
                clips.append({'clipId': f'track-{i}:clip-{j}', 'name': slot.clip.name})
        session.append({'trackId': f'track-{i}', 'name': track.name, 'clips': clips,
                        'playingSlotIndex': None if track.is_foldable else int(track.playing_slot_index)})
    arrangement, clips = _inventory(song)
    if any(not all(math.isfinite(c[k]) for k in ('startBeats', 'endBeats')) or c['endBeats'] < c['startBeats'] for c in arrangement):
        raise ValueError('existing Arrangement clip boundaries are unavailable')
    if any(c['endBeats'] > start for c in arrangement):
        raise ValueError('choose an append position after all existing Arrangement clips on every track')
    if not any(t['clips'] for t in session):
        raise ValueError('prepare Session clips before recording their Arrangement performance')
    refs.append(clips)
    refs = tuple(refs)
    if refs != _identity:
        _identity, _token = refs, str(uuid.uuid4())
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': _token,
            'startBeats': start, 'endBeats': end, 'currentSongTime': float(song.current_song_time),
            'barPosition': position,
            'controls': controls, 'session': session, 'arrangement': arrangement,
            'musical': {'tempo': float(song.tempo), 'numerator': int(song.signature_numerator),
                        'denominator': int(song.signature_denominator),
                        'launchQuantization': int(song.clip_trigger_quantization)}}


def _same_setup(record, song):
    return record['song'] == song and record['tracks'] == tuple(song.tracks) and _controls(song) == record['controls']


def _stop(record, song, target, reason, now):
    if not _same_setup(record, song):
        record.update(status='ownership_lost', reason='Recording scope changed; global recording and transport left untouched')
        return
    errors = []
    for action in (lambda: setattr(song, 'record_mode', False), song.stop_playing):
        try:
            unchanged = _same_setup(record, song)
        except Exception as error:
            unchanged = False
            errors.append(str(error) or error.__class__.__name__)
        if not unchanged:
            record.update(status='ownership_lost', reason='Recording scope changed between stop commands; partial state retained', cleanupErrors=errors)
            return
        try:
            action()
        except Exception as error:
            errors.append(str(error) or error.__class__.__name__)
    record.update(status='cleanup_failed' if errors else 'stopping', stopTarget=target,
                  stopDeadline=now+3, reason=reason, cleanupErrors=errors)
    if not errors:
        _settle(record, song, now)


def _settle(record, song, now):
    if not _same_setup(record, song):
        record.update(status='ownership_lost', reason='Recording scope changed while stop was pending')
    elif not song.record_mode and not song.is_playing and not song.is_counting_in:
        record['status'] = record['stopTarget']
    elif now >= record['stopDeadline']:
        record.update(status='cleanup_failed', cleanupErrors=['Native recording/transport stop did not verify within three seconds'])


def start(song, params, version):
    before = source(song, params, version)
    if params.get('expectedStateVersion') != version or params.get('before') != before:
        raise ValueError('Session Arrangement recording context changed after planning')
    record = None
    try:
        with _undo_step(song):
            if source(song, params, version) != before:
                raise ValueError('Session Arrangement recording context changed at undo entry')
            song.start_time = before['startBeats']
            prepared = {**before, 'controls': {**before['controls'], 'startMarkerBeats': before['startBeats']}}
            if source(song, params, version) != prepared:
                raise ValueError('Prepared insert marker or recording context did not verify; recording was not requested')
            _, original = _inventory(song)
            key = str(uuid.uuid4())
            now = time.monotonic()
            record = {'recordingId': key, 'song': song, 'tracks': tuple(song.tracks), 'controls': prepared['controls'],
                      'startBeats': before['startBeats'], 'endBeats': before['endBeats'], 'status': 'starting',
                      'startDeadline': now+3, 'deadline': now+300, 'recordingRequested': True,
                      'original': {track_id: tuple(clip for _, clip in entries)
                                   for track_id, entries in _by_track(before['arrangement'], original).items()},
                      'beforeBounds': before['arrangement'], 'cleanupErrors': []}
            _recordings[key] = record
            song.record_mode = True
            if not _same_setup(record, song):
                raise ValueError('Recording scope changed after record request; playback start was not dispatched')
            song.start_playing()
    except Exception as error:
        if record is None:
            raise
        record['startError'] = str(error) or error.__class__.__name__
    advance(song)
    return read(song, {'recordingId': record['recordingId']}, version+1)


def has_active():
    return any(r['status'] in _active for r in _recordings.values())


def advance(song, now=None):
    changed = 0
    for record in _recordings.values():
        old = record['status']
        if old not in ('starting', 'start_unverified', 'recording', 'stopping'):
            continue
        moment = time.monotonic() if now is None else now
        try:
            if not _same_setup(record, song):
                record.update(status='ownership_lost', reason='Recording scope changed; inspect global recording before another action')
            elif old == 'stopping':
                _settle(record, song, moment)
            elif old in ('starting', 'start_unverified'):
                if song.is_counting_in:
                    if moment >= record['deadline']:
                        _stop(record, song, 'interrupted', 'Count-in exceeded wall-clock limit', moment)
                elif song.record_mode and song.is_playing:
                    record['status'] = 'recording'
                    if record.get('cancelRequested') or record.get('startError'):
                        _stop(record, song, 'cancelled' if record.get('cancelRequested') else 'interrupted', 'Pending start resolved; requested stop', moment)
                elif moment >= record['startDeadline']:
                    record.update(status='start_unverified', reason='Native start unconfirmed; inspect retained recording before retrying')
            elif not song.record_mode:
                record.update(status='ownership_lost', reason='Arrangement recording switched off; playback left untouched')
            elif not song.is_playing or song.current_song_time < record['startBeats']-1e-5 or moment >= record['deadline']:
                _stop(record, song, 'interrupted', 'Playback, playhead or wall-clock limit interrupted recording', moment)
            elif song.current_song_time >= record['endBeats']:
                _stop(record, song, 'stopped', 'Requested beat endpoint reached on a Live display tick', moment)
        except Exception as error:
            record.update(status='ownership_lost', reason=str(error) or error.__class__.__name__)
        changed += int(old != record['status'])
    return changed


def _by_track(rows, objects):
    grouped = {}
    for row, (_, clip) in zip(rows, objects):
        grouped.setdefault(row['id'].split(':', 1)[0], []).append((row, clip))
    return grouped


def read(song, params, version):
    controls, control_error = None, None
    try:
        controls = _controls(song)
    except Exception as error:
        control_error = str(error) or error.__class__.__name__
    key = params.get('recordingId')
    if key is None:
        preparation = {'currentSongTime': float(song.current_song_time), 'isPlaying': bool(song.is_playing),
                       'arrangementRecord': bool(song.record_mode), 'controls': controls, 'controlError': control_error,
                       'tempo': float(song.tempo)}
        try:
            preparation.update(barPosition=_bar_position(song), barPositionError=None)
        except Exception as error:
            preparation.update(barPosition=None, barPositionError=str(error) or error.__class__.__name__)
        try:
            preparation['arrangement'], _ = _inventory(song)
            preparation['appendAfterBeats'] = max((c['endBeats'] for c in preparation['arrangement']), default=0)
            preparation['inspectionError'] = None
        except Exception as error:
            preparation.update(arrangement=None, appendAfterBeats=None, inspectionError=str(error) or error.__class__.__name__)
        return {'stateVersion': version, 'recordings': [read(song, {'recordingId': k}, version) for k in _recordings],
                'preparation': preparation}
    if key not in _recordings:
        raise ValueError('Session Arrangement handle unavailable; inspect current clips before retrying')
    r = _recordings[key]
    same_document = r['song'] == song and r['tracks'] == tuple(song.tracks)
    captured, preserved, inspection_error = [], None, None
    if same_document:
        try:
            inventory, objects = _inventory(song)
            grouped = _by_track(inventory, objects)
            for track_id, prefix in r['original'].items():
                current = grouped.get(track_id, [])
                if tuple(clip for _, clip in current[:len(prefix)]) != prefix:
                    raise ValueError('Original Arrangement clip prefix changed; captured clips cannot be identified reliably')
            originals = []
            for track_id, entries in grouped.items():
                count = len(r['original'].get(track_id, ()))
                originals.extend(row for row, _ in entries[:count])
                captured.extend(row for row, _ in entries[count:])
            preserved = originals == r['beforeBounds']
        except Exception as error:
            inspection_error = str(error) or error.__class__.__name__
    status = r['status'] if same_document else 'ownership_lost'
    control = {'sourceSetMatches': same_document, 'controls': controls, 'recording': bool(song.record_mode),
               'playing': bool(song.is_playing), 'status': status, 'cancelRequested': bool(r.get('cancelRequested', False))}
    return {'stateVersion': version, 'recordingId': key, 'status': status,
            'recordingRequested': r['recordingRequested'],
            'recordingActiveObserved': bool(status == 'recording' and same_document and controls == r['controls'] and song.record_mode and song.is_playing and not song.is_counting_in),
            'countingIn': bool(song.is_counting_in), 'arrangementRecordObserved': bool(song.record_mode),
            'stopVerified': status in ('stopped', 'cancelled', 'interrupted') and not song.record_mode and not song.is_playing and not song.is_counting_in,
            'startBeats': r['startBeats'], 'endBeats': r['endBeats'], 'capturedClips': captured,
            'originalClipMetadataPreserved': preserved, 'performanceVerified': False, 'gestureAutomationRequested': False,
            'capturedClipsAvailable': same_document and inspection_error is None, 'inspectionError': inspection_error,
            'controlError': control_error,
            'cleanupErrors': r['cleanupErrors'], 'startError': r.get('startError'), 'reason': r.get('reason'),
            'controlContext': control}


def finish(song, params, version):
    if params.get('expectedStateVersion') != version or 'cancel' in params and type(params['cancel']) is not bool:
        raise ValueError('fresh expectedStateVersion and optional boolean cancel are required')
    state = read(song, params, version)
    if state['controlContext']['controls'] is None:
        raise ValueError('recording controls unavailable; inspect current global recording before stopping')
    if state['controlContext'] != params.get('before', {}).get('controlContext'):
        raise ValueError('Session Arrangement recording controls changed after planning')
    r = _recordings[params['recordingId']]
    if r['status'] in _active:
        if params.get('cancel') is not True:
            raise ValueError('cancel true is required to end an active recording early')
        r['cancelRequested'] = True
        if r['status'] not in ('starting', 'start_unverified'):
            _stop(r, song, 'cancelled', 'Requested early stop; partial clips retained', time.monotonic())
        state = read(song, params, version+1)
    if r['status'] in _active or state['status'] == 'ownership_lost' and song.record_mode:
        return {**state, 'released': False}
    del _recordings[params['recordingId']]
    return {**state, 'stateVersion': version+1, 'released': True}


def shutdown(song):
    for record in _recordings.values():
        if record['song'] == song and record['status'] in ('starting', 'recording', 'start_unverified', 'cleanup_failed'):
            if record['status'] in ('starting', 'start_unverified'):
                record.update(cancelRequested=True, reason='Bridge shutdown during unconfirmed start; retained cancellation requires native observation after reload')
                continue
            try:
                _stop(record, song, 'interrupted', 'Bridge shutdown', time.monotonic())
            except Exception as error:
                record.update(status='cleanup_failed', cleanupErrors=[str(error) or error.__class__.__name__])
