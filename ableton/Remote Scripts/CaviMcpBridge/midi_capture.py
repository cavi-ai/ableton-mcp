"""Global Capture MIDI context, native identity guards and observed content changes."""
import hashlib
import json
import uuid

try:
    from .bridge import (_clip_list, _clip_timing, _midi_note_record, _track_routing,
                         _track_midi_routing, _transport_recording_context,
                         _song_musical_context, _set_fingerprint)
except ImportError:
    from bridge import (_clip_list, _clip_timing, _midi_note_record, _track_routing,
                        _track_midi_routing, _transport_recording_context,
                        _song_musical_context, _set_fingerprint)

_identity = None
_token = None


def context(song, version):
    global _identity, _token
    if len(song.tracks) > 256:
        raise ValueError('MIDI capture context supports at most 256 tracks')
    refs, tracks, activity, possible, overdubs = [song, tuple(song.tracks), tuple(song.scenes)], [], [], [], []
    slot_count, note_count = 0, 0
    for index, track in enumerate(song.tracks):
        track_id = 'track-%s' % index
        slots = tuple(track.clip_slots)
        slot_count += len(slots)
        if slot_count > 16384:
            raise ValueError('MIDI capture context supports at most 16384 Session slots')
        refs.extend(slots)
        refs.extend(slot.clip for slot in slots if slot.has_clip)
        armed = bool(track.arm) if getattr(track, 'can_be_armed', True) else False
        activity.append({'trackId': track_id, 'armed': armed,
                         'playingSlotIndex': int(track.playing_slot_index),
                         'firedSlotIndex': int(track.fired_slot_index),
                         'recordingSlots': [i for i, slot in enumerate(slots)
                                            if slot.has_clip and bool(getattr(slot.clip, 'is_recording', False))],
                         'pendingSlots': [i for i, slot in enumerate(slots)
                                          if bool(getattr(slot, 'is_triggered', False)) or
                                          slot.has_clip and bool(getattr(slot.clip, 'is_triggered', False))]})
        if not bool(getattr(track, 'has_midi_input', False)):
            continue
        records = _clip_list(song, track_id, version)['clips']
        monitoring = int(track.current_monitoring_state)
        may_capture = armed or monitoring == 0
        if may_capture:
            possible.append(track_id)
        for slot, record in zip(slots, records):
            record['noteCount'], record['noteDigest'], record['timing'] = 0, None, None
            if slot.has_clip:
                notes = sorted((_midi_note_record(note) for note in slot.clip.get_all_notes_extended()),
                               key=lambda note: note['noteId'])
                note_count += len(notes)
                if note_count > 16384:
                    raise ValueError('MIDI capture context supports at most 16384 existing notes')
                record['noteCount'] = len(notes)
                record['noteDigest'] = hashlib.sha256(json.dumps(notes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                record['timing'] = {key: value for key, value in _clip_timing(song, track_id, record['id'], version).items()
                                    if key not in ('stateVersion', 'availableGrooves')}
                if may_capture and record['isPlaying']:
                    overdubs.append(record['id'])
        tracks.append({'trackId': track_id, 'name': str(track.name), 'armed': armed,
                       'isFrozen': bool(getattr(track, 'is_frozen', False)),
                       'monitoring': monitoring, 'routing': _track_routing(song, track_id, version),
                       'midiRouting': _track_midi_routing(song, track_id, version), 'clips': records})
    refs = tuple(refs)
    if _identity != refs:
        _identity, _token = refs, str(uuid.uuid4())
    transport = _transport_recording_context(song, version)
    transport.pop('currentSongTime')  # A moving clock is not a stable confirmation field.
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': _token,
            'available': transport['midiCapture']['available'], 'bufferContentsAvailable': False,
            'possibleTrackIds': possible, 'overdubClipIds': overdubs, 'tracks': tracks,
            'trackActivity': activity, 'sceneNames': [str(scene.name) for scene in song.scenes],
            'tempo': float(song.tempo), 'transport': transport, 'musicalContext': _song_musical_context(song, version)}


def capture(song, params, version):
    before = context(song, version)
    if params.get('expectedStateVersion') != version or params.get('before') != before:
        raise ValueError('MIDI capture context or native identity changed')
    if not before['available']:
        raise ValueError('no MIDI material is available to capture')
    allow_existing = params.get('allowExistingClipChanges') is True
    if before['overdubClipIds'] and not allow_existing:
        raise ValueError('Capture MIDI may change a playing Session clip; explicit existing-clip scope required')
    if before['transport']['arrangement']['record'] or before['transport']['session']['record'] or any(
            item['recordingSlots'] or item['pendingSlots'] or item['firedSlotIndex'] != -1
            for item in before['trackActivity']):
        raise ValueError('resolve recording and pending launches before MIDI capture')
    if any(track['isFrozen'] and track['trackId'] in before['possibleTrackIds'] for track in before['tracks']):
        raise ValueError('resolve frozen capture tracks')
    transport_before = _transport_recording_context(song, version)
    song.capture_midi(1)
    receipt = {'stateVersion': version + 1, 'destination': 'session', 'captureRequested': True,
               'captureVerified': False, 'before': transport_before,
               'after': _transport_recording_context(song, version + 1),
               'tempoBefore': before['tempo'], 'tempoAfter': float(song.tempo),
               'sceneCountBefore': len(before['sceneNames']), 'sceneCountAfter': len(song.scenes)}
    try:
        after = context(song, version + 1)
        previous = {clip['id']: clip for track in before['tracks'] for clip in track['clips']}
        current = {clip['id']: clip for track in after['tracks'] for clip in track['clips']}
        changed, existing_changes = [], []
        for clip_id in sorted(set(previous) | set(current)):
            old, new = previous.get(clip_id), current.get(clip_id)
            content = lambda clip: None if not clip or not clip['hasClip'] else (
                clip['name'], clip['noteDigest'], {key: value for key, value in clip['timing'].items() if key != 'stateVersion'})
            if content(old) == content(new):
                continue
            changed.append({'clipId': clip_id, 'before': old, 'after': new,
                            'noteCountBefore': old['noteCount'] if old else 0,
                            'noteCountAfter': new['noteCount'] if new else 0,
                            'noteStateChanged': (old or {}).get('noteDigest') != (new or {}).get('noteDigest')})
            if old and old['hasClip']:
                existing_changes.append(clip_id)
        receipt.update(changedSlots=changed, existingContentPreserved=not existing_changes,
                       existingChangedClipIds=existing_changes,
                       unexpectedExistingChanges=existing_changes if not allow_existing else [],
                       captureVerified=any(change['noteStateChanged'] and change['noteCountAfter'] > 0 for change in changed)
                           and (allow_existing or not existing_changes))
    except Exception as error:
        receipt['verificationError'] = str(error)
    return receipt
