"""Return explicit ordinary tracks to Arrangement without transport writes."""
import re
import uuid

try:
    from .bridge import _track, _set_fingerprint, _arrangement_clip_record, _transport_recording_context
    from . import clip_hold
except ImportError:
    from bridge import _track, _set_fingerprint, _arrangement_clip_record, _transport_recording_context
    import clip_hold

_contexts = {}
_document = None


def _ids(params):
    ids = params.get('trackIds')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 64 or any(
            not isinstance(key, str) or not re.fullmatch(r'track-(0|[1-9][0-9]*)', key) for key in ids) or len(set(ids)) != len(ids):
        raise ValueError('return requires 1-64 unique ordinary track IDs')
    return ids


def _controls(song):
    recording = _transport_recording_context(song, 0)
    return {'isPlaying': recording['isPlaying'], 'metronome': recording['metronome'],
            'arrangement': {key: value for key, value in recording['arrangement'].items() if key != 'backToArranger'},
            'session': recording['session'], 'automationArm': recording['automationArm'],
            'tempo': float(song.tempo), 'numerator': int(song.signature_numerator), 'denominator': int(song.signature_denominator),
            'loop': {'enabled': bool(song.loop), 'startBeats': float(song.loop_start), 'lengthBeats': float(song.loop_length)}}


def _safe(song, track):
    if song.record_mode or song.session_record or bool(getattr(song, 'is_counting_in', False)):
        raise ValueError('resolve recording and count-in before returning tracks')
    if bool(track.arm) or bool(getattr(track, 'implicit_arm', False)) or track.is_frozen:
        raise ValueError('return requires unarmed, unfrozen target tracks')
    if int(track.fired_slot_index) != -1 or any(bool(getattr(slot, 'is_triggered', False)) or
            slot.has_clip and bool(getattr(slot.clip, 'is_triggered', False)) for slot in track.clip_slots):
        raise ValueError('resolve pending target launches before returning tracks')
    if any(slot.has_clip and (bool(getattr(slot.clip, 'is_recording', False)) or
            bool(getattr(slot.clip, 'is_overdubbing', False))) for slot in track.clip_slots):
        raise ValueError('resolve target clip recording before returning tracks')
    if clip_hold.has_unresolved(track):
        raise ValueError('release the target track hold before returning to Arrangement')


def _capture(song, ids, version, guarded=False):
    tracks = tuple(song.tracks)
    if len(tracks) > 256:
        raise ValueError('return supports at most 256 tracks')
    rows, bindings, total = [], [], 0
    for key in ids:
        _, track = _track(song, key)
        if bool(getattr(track, 'is_foldable', False)):
            raise ValueError('Group return affects descendants; select ordinary tracks explicitly')
        if not hasattr(track, 'back_to_arranger'):
            raise ValueError('Single Track Back to Arrangement is unavailable')
        slots, arranged = tuple(track.clip_slots), tuple(track.arrangement_clips)
        total += len(arranged)
        if len(slots) > 1024 or total > 4096:
            raise ValueError('return supports 1024 slots per target and 4096 requested Arrangement clips')
        index = int(track.playing_slot_index)
        if index not in (-2, -1) and not 0 <= index < len(slots):
            raise ValueError('target playback state is unavailable')
        slot = slots[index] if index >= 0 else None
        clip = slot.clip if slot is not None and slot.has_clip else None
        if index >= 0 and clip is None:
            raise ValueError('target playing clip is unavailable')
        if guarded:
            _safe(song, track)
            if index >= 0 and not track.back_to_arranger:
                raise ValueError('target Session and Arrangement state disagree; read again')
        bindings.append((track, index, slot, clip, arranged))
        rows.append({'id': key, 'name': track.name, 'arrangementOverride': bool(track.back_to_arranger),
                     'playingSlotIndex': index, 'firedSlotIndex': int(track.fired_slot_index),
                     'playingClip': {'id': f'{key}:clip-{index}', 'name': clip.name} if clip is not None else None,
                     'mute': bool(track.mute), 'solo': bool(track.solo), 'armed': bool(track.arm),
                     'implicitArm': bool(getattr(track, 'implicit_arm', False)), 'frozen': bool(track.is_frozen),
                     'arrangementClips': [_arrangement_clip_record(item, key, i) for i, item in enumerate(arranged)]})
    others = [{'id': f'track-{i}', 'name': track.name, 'arrangementOverride': bool(track.back_to_arranger)}
              for i, track in enumerate(tracks) if f'track-{i}' not in ids and not bool(getattr(track, 'is_foldable', False))]
    return ({'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'trackIds': list(ids),
             'controls': _controls(song), 'tracks': rows, 'otherTracks': others}, (song, tracks, tuple(bindings)))


def source(song, params, version):
    global _document
    ids = _ids(params)
    view, binding = _capture(song, ids, version, guarded=True)
    if _document != song:
        _contexts.clear()
        _document = song
    key = tuple(ids)
    cached = _contexts.get(key)
    if cached is None or cached[0] != binding:
        if key not in _contexts and len(_contexts) >= 32:
            del _contexts[next(iter(_contexts))]
        cached = (binding, str(uuid.uuid4()))
        _contexts[key] = cached
    view['identityToken'] = cached[1]
    return view


def _owned(song, binding):
    original, tracks, targets = binding
    if song != original or tuple(song.tracks) != tracks:
        raise ValueError('native track identity changed during return')
    for track, index, slot, clip, arranged in targets:
        if tuple(track.arrangement_clips) != arranged or slot is not None and (
                index >= len(track.clip_slots) or track.clip_slots[index] != slot or not slot.has_clip or slot.clip != clip):
            raise ValueError('native source clip identity changed during return')
        if int(track.playing_slot_index) not in (-2, -1, index):
            raise ValueError('target playback changed during return')


def begin(song, params, version):
    before = source(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('Arrangement return context or native identity changed')
    binding = _contexts[tuple(before['trackIds'])][0]
    operation = {'before': before, 'binding': binding, 'error': None, 'requested': [],
                 'positionBeforeBeats': float(song.current_song_time)}
    try:
        for row, target in zip(before['tracks'], binding[2]):
            _owned(song, binding)
            if _controls(song) != before['controls']:
                raise ValueError('transport controls changed during return')
            for item in binding[2]:
                _safe(song, item[0])
            if row['arrangementOverride']:
                operation['requested'].append(row['id'])
                target[0].back_to_arranger = False
        _owned(song, binding)
    except Exception as error:
        operation['error'] = str(error) or error.__class__.__name__
    return operation


def complete(song, operation, version):
    before, binding = operation['before'], operation['binding']
    result = {'stateVersion': version, 'returned': False, 'partial': True, 'error': operation['error'],
              'requestedTrackIds': list(operation['requested']), 'playheadWriteRequested': False,
              'positionBeforeBeats': operation['positionBeforeBeats'], 'observed': None}
    if song != binding[0]:
        return {**result, 'observationError': 'source Set changed during return'}
    try:
        observed, _ = _capture(song, before['trackIds'], version)
        owned = True
        try:
            _owned(song, binding)
        except ValueError:
            owned = False
        safe, safety_error = True, None
        try:
            for target in binding[2]:
                _safe(song, target[0])
        except Exception as error:
            safe, safety_error = False, str(error) or error.__class__.__name__
        checks = {'targetsSafe': safe, 'topologyStable': tuple(song.tracks) == binding[1], 'nativeSourcesPreserved': owned,
                  'tracksReturned': all(not row['arrangementOverride'] and row['playingSlotIndex'] < 0 for row in observed['tracks']),
                  'unrelatedOverridesPreserved': observed['otherTracks'] == before['otherTracks'],
                  'controlsPreserved': observed['controls'] == before['controls'],
                  'recordingOff': not song.record_mode and not song.session_record and not bool(getattr(song, 'is_counting_in', False))}
        returned = operation['error'] is None and all(checks.values())
        return {**result, 'returned': returned, 'partial': not returned, 'observed': observed,
                'positionAfterBeats': float(song.current_song_time), 'verification': checks, 'safetyError': safety_error,
                'limitation': 'Immediate native return, not beat scheduling or audible verification. The running playhead can advance. Earlier Session phase is not restored; inspect partial state before retrying.'}
    except Exception as error:
        return {**result, 'observationError': str(error) or error.__class__.__name__}


def start(song, params, version):
    return complete(song, begin(song, params, version), version + 1)
