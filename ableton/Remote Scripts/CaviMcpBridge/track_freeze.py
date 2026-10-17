"""Read-only native identity and exposed material for track freezing."""
import hashlib
import json
import os
import uuid
try:
    from .bridge import (_track, _track_freeze_state, _track_state_snapshot, _clip_timing,
                         _audio_clip_state, _midi_note_record, _set_fingerprint)
except ImportError:
    from bridge import (_track, _track_freeze_state, _track_state_snapshot, _clip_timing,
                        _audio_clip_state, _midi_note_record, _set_fingerprint)

_identities = {}
_song = None


def _ui_path(song, target):
    tracks, current, lineage = list(song.tracks), target, []
    def parent(track):
        return track.group_track if bool(getattr(track, 'is_grouped', False)) else None
    seen = []
    while current is not None:
        if current in seen or current not in tracks:
            raise ValueError('native track hierarchy is unavailable or cyclic')
        seen.append(current)
        owner = parent(current)
        siblings = [track for track in tracks if parent(track) == owner]
        lineage.insert(0, ('.GroupTrack' if getattr(current, 'is_foldable', False) else '.Track') + '[%s]' % siblings.index(current))
        current = owner
    return ''.join(lineage)


def source(song, params, version):
    global _song, _identities
    if _song != song:
        _song, _identities = song, {}
    key = params['trackId']
    _, track = _track(song, key)
    if getattr(track, 'is_foldable', False) or len(song.tracks) > 256:
        raise ValueError('freeze requires one ordinary track in a Set with at most 256 tracks')
    native, realtime, count = [], [], [0]
    def devices(items):
        for device in items:
            count[0] += 1
            if count[0] > 512:
                raise ValueError('freeze context exceeds 512 devices')
            native.extend([device, tuple(device.parameters)])
            if device.class_name in ('ExternalInstrument', 'ExternalAudioEffect'):
                realtime.append(str(device.name))
            chains = list(device.chains) + list(getattr(device, 'return_chains', ())) if bool(getattr(device, 'can_have_chains', False)) else []
            for chain in chains:
                native.append(chain)
                devices(chain.devices)
    devices(track.devices)
    slots, arrangement = list(track.clip_slots), list(getattr(track, 'arrangement_clips', ()))
    if len(slots) + len(arrangement) > 1024:
        raise ValueError('freeze context exceeds 1024 clips and slots')
    clips = [(key + ':clip-%s' % i, slot.clip) for i, slot in enumerate(slots) if slot.has_clip]
    clips += [(key + ':arrangement-clip-%s' % i, clip) for i, clip in enumerate(arrangement)]
    material, notes = [], 0
    for clip_id, clip in clips:
        row = {'id': clip_id, 'name': str(clip.name), 'timing': _clip_timing(song, key, clip_id, version)}
        if getattr(clip, 'is_audio_clip', False):
            row['audio'] = _audio_clip_state(song, key, clip_id, version)
        else:
            row['notes'] = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
            notes += len(row['notes'])
            if notes > 16384:
                raise ValueError('freeze context exceeds 16384 stored MIDI notes')
        material.append(row)
    identity = (song, tuple(song.tracks), track, tuple(slots), tuple(clip for _, clip in clips), tuple(native))
    previous = _identities.get(key)
    if previous is None or previous[0] != identity:
        _identities[key] = (identity, str(uuid.uuid4()))
    pending = any(int(t.fired_slot_index) != -1 for t in song.tracks)
    pending = pending or any(bool(getattr(clip, 'is_recording', False)) or bool(getattr(clip, 'is_triggered', False)) for _, clip in clips)
    content = {'track': _track_state_snapshot(song, key, version), 'clips': material}
    path = str(song.file_path)
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': _identities[key][1],
            'filePath': path, 'setName': str(getattr(song, 'name', None) or os.path.splitext(os.path.basename(path))[0]),
            'scriptDirectory': os.path.dirname(__file__), 'trackId': key, 'name': str(track.name), 'uiPath': _ui_path(song, track),
            'freeze': _track_freeze_state(song, key, version)['freeze'], 'clipCount': len(clips), 'realtimeDevices': realtime,
            'otherFreezeStates': [bool(t.is_frozen) for t in song.tracks if t != track],
            'readiness': {'playing': bool(song.is_playing), 'arrangement': bool(song.record_mode),
                          'session': bool(song.session_record), 'countingIn': bool(getattr(song, 'is_counting_in', False)),
                          'armed': bool(track.arm), 'pending': pending},
            'contentSha256': hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()}
