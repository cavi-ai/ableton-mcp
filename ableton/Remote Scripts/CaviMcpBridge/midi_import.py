"""Bind an empty final Session track for native MIDI file import."""
import os
import uuid
try:
    from .bridge import _track, _clip_slot, _track_routing, _set_fingerprint
    from .browser_load import capture, effects, owner_id
except ImportError:
    from bridge import _track, _clip_slot, _track_routing, _set_fingerprint
    from browser_load import capture, effects, owner_id

_records, _targets = {}, {}


def _device_graph(devices):
    budget = [4096]
    def walk(devices, depth):
        if depth > 16:
            raise ValueError('MIDI import device structure exceeds 16 nested racks')
        result = []
        for device in devices:
            budget[0] -= 1
            if budget[0] < 0:
                raise ValueError('MIDI import device structure exceeds 4096 devices')
            chains = tuple(device.chains) if bool(getattr(device, 'can_have_chains', False)) else ()
            returns = tuple(getattr(device, 'return_chains', ())) if bool(getattr(device, 'can_have_drum_pads', False)) else ()
            result.append((device, tuple((c, walk(c.devices, depth+1)) for c in chains),
                           tuple((c, walk(c.devices, depth+1)) for c in returns)))
        return tuple(result)
    return walk(devices, 0)


def _structure(track):
    return (track, _device_graph(track.devices), tuple((s, s.clip if s.has_clip else None) for s in track.clip_slots),
            () if bool(getattr(track, 'is_foldable', False)) else tuple(getattr(track, 'arrangement_clips', ())))


def _musical(song):
    return {'tempo': float(song.tempo), 'numerator': int(song.signature_numerator), 'denominator': int(song.signature_denominator)}


def source(song, params, version):
    index, track = _track(song, params['trackId'])
    _, slot_index, slot = _clip_slot(song, params['trackId'], params['clipId'])
    if index != len(song.tracks)-1 or bool(getattr(track, 'is_grouped', False)) or bool(getattr(track, 'is_foldable', False)) or not track.has_midi_input:
        raise ValueError('MIDI import requires the last ungrouped ordinary MIDI staging track')
    if song.is_playing or song.record_mode or song.session_record or bool(getattr(song, 'is_counting_in', False)) or any(int(t.fired_slot_index) != -1 for t in song.tracks):
        raise ValueError('MIDI import requires stopped playback/recording and no pending launches')
    if track.devices or any(s.has_clip for s in track.clip_slots) or tuple(getattr(track, 'arrangement_clips', ())):
        raise ValueError('MIDI import staging track must have no devices or clips')
    routing = _track_routing(song, params['trackId'], version)
    if not track.mute or track.arm or track.solo or int(track.current_monitoring_state) != 2 or bool(getattr(track, 'is_frozen', False)) or routing['output']['type']['name'] not in ('No Output', 'None'):
        raise ValueError('MIDI import staging track must be muted, unarmed, unfrozen, unsoloed, monitoring off and No Output')
    structure = tuple(_structure(t) for t in song.tracks)
    identity = (song, capture(song), tuple(song.return_tracks), song.master_track, track, slot, structure, _musical(song))
    key = (params['trackId'], params['clipId'])
    cached = _targets.get(key)
    if cached is None or cached[0] != identity or cached[1] not in _records:
        token = str(uuid.uuid4())
        if len(_records) >= 64:
            _records.pop(next(iter(_records)))
        if len(_targets) >= 64:
            _targets.pop(next(iter(_targets)))
        _targets[key] = identity, token
        _records[token] = {'song': song, 'topology': capture(song), 'structure': structure, 'target': track,
                           'slot': slot, 'musical': _musical(song)}
    token = _targets[key][1]
    roots = [t for t in song.tracks if not bool(getattr(t, 'is_grouped', False))]
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': token,
            'trackId': params['trackId'], 'clipId': params['clipId'], 'name': track.name, 'sceneIndex': slot_index,
            'trackUIPath': '.Track[%s]' % roots.index(track), 'filePath': str(getattr(song, 'file_path', None) or ''),
            'scriptDirectory': os.path.dirname(__file__), 'musical': _musical(song),
            'tracks': [{'id': f'track-{i}', 'name': t.name} for i, t in enumerate(song.tracks)],
            'scenes': [{'id': f'scene-{i}', 'name': s.name} for i, s in enumerate(song.scenes)]}


def select(song, params, version, application):
    before = source(song, params, version)
    if params.get('expectedStateVersion') != version or params.get('before') != before:
        raise ValueError('native MIDI import target changed before selection')
    if application is None:
        raise ValueError('native MIDI import selection unavailable')
    _, track = _track(song, params['trackId'])
    _, index, slot = _clip_slot(song, params['trackId'], params['clipId'])
    song.view.selected_track = track
    song.view.selected_scene = song.scenes[index]
    song.view.highlighted_clip_slot = slot
    application.view.show_view('Session')
    application.view.focus_view('Session')
    if song.view.selected_track != track or song.view.highlighted_clip_slot != slot:
        raise RuntimeError('native MIDI import target selection did not verify')
    return {'stateVersion': version+1, 'source': source(song, params, version+1)}


def inspect(song, token, version):
    record = _records.get(token)
    if record is None or record['song'] != song:
        raise ValueError('native MIDI import handle is unavailable for this Set')
    target, topology = record['target'], record['topology']
    existing = tuple(song.tracks[:len(topology[0])]) == topology[0] and tuple(song.scenes[:len(topology[1])]) == topology[1]
    for old, devices, slots, arrangement in record['structure']:
        if old not in song.tracks:
            existing = False
            continue
        existing = existing and _device_graph(old.devices) == devices and (() if bool(getattr(old, 'is_foldable', False)) else tuple(getattr(old, 'arrangement_clips', ()))) == arrangement
        if old != target:
            current = tuple((s, s.clip if s.has_clip else None) for s in old.clip_slots)
            existing = existing and current[:len(slots)] == slots
    track_id = owner_id(song, target)
    clips = [{'id': f'{track_id}:clip-{i}', 'name': s.clip.name, 'lengthBeats': float(s.clip.length),
              'type': 'audio' if bool(getattr(s.clip, 'is_audio_clip', False)) else 'midi'}
             for i, s in enumerate(target.clip_slots) if s.has_clip] if track_id else []
    return {'stateVersion': version, 'trackId': track_id, 'targetClips': clips, 'trackEffect': effects(song, topology),
            'existingStructurePreserved': bool(existing), 'musicalUnchanged': _musical(song) == record['musical'],
            'recordingStopped': not (song.is_playing or song.record_mode or song.session_record),
            'limitation': 'Native track/device/clip object structure only; note, parameter, automation, controller and external-file contents are not compared.'}
