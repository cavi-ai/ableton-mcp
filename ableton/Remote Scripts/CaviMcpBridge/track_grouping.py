"""Native evidence for an explicit track-grouping UI command."""
import hashlib
import json
import os
import re
import uuid
try:
    from .bridge import (_track, _track_record, _track_routing, _track_state_snapshot, _persisted_track_state,
                         _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint,
                         _song_musical_context, _transport_recording_context, _set_mixer)
except ImportError:
    from bridge import (_track, _track_record, _track_routing, _track_state_snapshot, _persisted_track_state,
                        _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint,
                        _song_musical_context, _transport_recording_context, _set_mixer)

_contexts = {}


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def _parent(track):
    return track.group_track if bool(getattr(track, 'is_grouped', False)) else None


def _global(song):
    recording = _transport_recording_context(song, 0)
    recording['midiCapture'].pop('midiTrackIds', None)
    return {'musical': _song_musical_context(song, 0), 'recording': recording,
            'mixer': _set_mixer(song, 0)}


def _controls(song, tracks, targets):
    rows = []
    for track in tracks:
        i = list(song.tracks).index(track)
        row = _track_record(song, track, i)
        for key in ('id', 'isGrouped', 'groupTrackId'):
            row.pop(key, None)
        routing = _track_routing(song, f'track-{i}', 0)
        row['routing'] = {side: {key: routing[side][key] for key in ('type', 'channel')}
                          for side in ('input', 'output') if side != 'output' or track not in targets}
        row['monitoring'] = routing['monitoring']
        row['sends'] = [float(p.value) for p in track.mixer_device.sends]
        rows.append(row)
    return rows


def _material(song, track, budget):
    index = list(song.tracks).index(track)
    key, refs = f'track-{index}', [track]
    def devices(items):
        for device in items:
            budget['devices'] += 1
            budget['parameters'] += len(device.parameters)
            if budget['devices'] > 512 or budget['parameters'] > 32768:
                raise ValueError('grouping evidence exceeds device or parameter limits')
            refs.extend([device, tuple(device.parameters)])
            if bool(getattr(device, 'can_have_chains', False)):
                for chain in [*device.chains, *getattr(device, 'return_chains', ())]:
                    refs.append(chain)
                    devices(chain.devices)
    devices(track.devices)
    slots, arrangement = list(track.clip_slots), list(getattr(track, 'arrangement_clips', ()))
    budget['slots'] += len(slots) + len(arrangement)
    if budget['slots'] > 4096:
        raise ValueError('grouping evidence exceeds 4096 slots and Arrangement clips')
    refs.extend(slots)
    clips = [(f'{key}:clip-{i}', slot.clip) for i, slot in enumerate(slots) if slot.has_clip]
    clips += [(f'{key}:arrangement-clip-{i}', clip) for i, clip in enumerate(arrangement)]
    material = []
    for clip_id, clip in clips:
        if bool(getattr(clip, 'is_recording', False)) or bool(getattr(clip, 'is_triggered', False)):
            raise ValueError('resolve target recording or pending launches before grouping')
        refs.append(clip)
        row = {'name': str(clip.name), 'color': getattr(clip, 'color', None), 'timing': _clip_timing(song, key, clip_id, 0)}
        if bool(getattr(clip, 'is_audio_clip', False)):
            row['audio'] = _audio_clip_state(song, key, clip_id, 0)
        else:
            row['notes'] = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
            budget['notes'] += len(row['notes'])
            if budget['notes'] > 16384:
                raise ValueError('grouping evidence exceeds 16384 stored MIDI notes')
        material.append(row)
    state = _persisted_track_state(_track_state_snapshot(song, key, 0))
    state['readiness'] = {'frozen': bool(track.is_frozen), 'armed': bool(track.arm),
                          'audioOutput': bool(getattr(track, 'has_audio_output', False))}
    state['routing'].pop('outputTypeId', None)
    state['routing'].pop('outputChannelId', None)
    def relative(value):
        if isinstance(value, list):
            return [relative(item) for item in value]
        if isinstance(value, dict):
            return {k: 'owner' + v[len(key):] if k == 'id' and isinstance(v, str) and v.startswith(key + ':') else relative(v)
                    for k, v in value.items() if k not in ('stateVersion', 'trackId', 'clipId')}
        return value
    return _hash(relative({'track': state, 'color': getattr(track, 'color', None), 'clips': material})), tuple(refs)


def _budget():
    return dict(devices=0, parameters=0, slots=0, notes=0)


def source(song, params, version):
    ids = params.get('trackIds')
    if not isinstance(ids, list) or not 2 <= len(ids) <= 64 or any(not isinstance(key, str) or re.fullmatch(r'track-(0|[1-9][0-9]*)', key) is None for key in ids):
        raise ValueError('two to 64 explicit canonical track IDs required')
    indices, tracks = zip(*[_track(song, key) for key in ids])
    if list(indices) != list(range(indices[0], indices[0] + len(ids))):
        raise ValueError('grouping requires consecutive tracks in Live order without duplicates')
    if not str(getattr(song, 'file_path', '')).startswith('/') or len(song.tracks) > 256 or len(song.return_tracks) > 64:
        raise ValueError('grouping requires a saved Set with at most 256 tracks and 64 Returns')
    if song.is_playing or song.record_mode or song.session_record or bool(getattr(song, 'is_counting_in', False)) or any(int(t.fired_slot_index) != -1 for t in song.tracks):
        raise ValueError('grouping requires stopped playback/recording and no pending launches')
    targets, material, native, budget = [], [], [], _budget()
    roots = [t for t in song.tracks if _parent(t) is None]
    for key, track in zip(ids, tracks):
        if bool(getattr(track, 'is_foldable', False)) or _parent(track) is not None or bool(track.arm) or bool(track.is_frozen) or not bool(getattr(track, 'has_audio_output', False)):
            raise ValueError('grouping requires ungrouped, unarmed, unfrozen ordinary audio-producing tracks')
        route = _track_routing(song, key, 0)['output']
        if route['type']['name'] != 'Main':
            raise ValueError('grouping requires each source output on Main')
        digest, refs = _material(song, track, budget)
        material.append(digest)
        native.append(refs)
        targets.append({'trackId': key, 'name': str(track.name), 'uiPath': f'.Track[{roots.index(track)}]',
                        'output': {k: route[k] for k in ('type', 'channel')}, 'contentSha256': digest})
    identity = (song, tuple(song.tracks), tuple(song.return_tracks), tuple(song.scenes), tuple(native), song.master_track)
    observed = {'filePath': str(song.file_path), 'setFingerprint': _set_fingerprint(song), 'targets': targets,
                'controls': _controls(song, song.tracks, tracks), 'globalContext': _global(song)}
    digest = _hash(observed)
    previous = next(((key, entry) for key, entry in _contexts.items() if entry['identity'] == identity and entry['digest'] == digest), None)
    if previous is None:
        if len(_contexts) >= 64:
            _contexts.pop(next(iter(_contexts)))
        token = str(uuid.uuid4())
        _contexts[token] = {'identity': identity, 'digest': digest, 'before': observed, 'tracks': tuple(song.tracks),
                            'targets': tracks, 'ids': ids, 'material': material, 'native': native,
                            'parents': tuple(_parent(t) for t in song.tracks), 'first': indices[0]}
    else:
        token = previous[0]
    return {'stateVersion': version, 'groupingId': token, 'identityToken': token, **observed,
            'setName': str(getattr(song, 'name', None) or os.path.splitext(os.path.basename(song.file_path))[0])}


def status(song, params, version):
    entry = _contexts.get(params.get('groupingId'))
    if entry is None or entry['identity'][0] != song:
        raise ValueError('grouping handle unavailable for this Live Set; inspect current tracks')
    current, original, targets = list(song.tracks), list(entry['tracks']), entry['targets']
    context = (str(song.file_path) == entry['before']['filePath'] and tuple(song.return_tracks) == entry['identity'][2]
               and tuple(song.scenes) == entry['identity'][3] and song.master_track == entry['identity'][5])
    extra = [t for t in current if t not in original]
    group = extra[0] if len(extra) == 1 and bool(getattr(extra[0], 'is_foldable', False)) else None
    order = group is not None and current == original[:entry['first']] + [group] + original[entry['first']:]
    membership = group is not None and _parent(group) is None and [t for t in current if _parent(t) == group] == list(targets)
    other_parents = all(_parent(t) == parent for t, parent in zip(original, entry['parents']) if t in current and t not in targets)
    members, preserved, routed, original_routing, budget, error = [], True, True, True, _budget(), None
    for i, target in enumerate(targets):
        member = {'sourceTrackId': entry['ids'][i], 'trackId': f'track-{current.index(target)}' if target in current else None}
        try:
            if target not in current:
                raise ValueError('original target is no longer present')
            digest, refs = _material(song, target, budget)
            route = _track_routing(song, member['trackId'], 0)['output']
            original_routing = original_routing and {k: route[k] for k in ('type', 'channel')} == entry['before']['targets'][i]['output']
            preserved = preserved and digest == entry['material'][i] and refs == entry['native'][i]
            routed = routed and route['type']['name'] == 'Group' and route['channel'] == entry['before']['targets'][i]['output']['channel']
            member.update(name=str(target.name), output={k: route[k] for k in ('type', 'channel')}, materialPreserved=digest == entry['material'][i] and refs == entry['native'][i])
        except Exception as failure:
            preserved, routed, original_routing = False, False, False
            error = error or str(failure)
        members.append(member)
    controls, global_context, group_record, renumbered = False, False, None, []
    try:
        expected_controls = []
        for i, (track, row) in enumerate(zip(original, entry['before']['controls'])):
            expected = dict(row)
            if order and track not in targets and bool(getattr(track, 'is_foldable', False)) and row['name'] == f'{i + 1}-Group':
                name = f'{current.index(track) + 1}-Group'
                if str(track.name) == name and name != row['name']:
                    expected['name'] = name
                    renumbered.append({'sourceTrackId': f'track-{i}', 'trackId': f'track-{current.index(track)}',
                                       'before': row['name'], 'after': name})
            expected_controls.append(expected)
        controls = _controls(song, original, targets) == expected_controls
        global_context = _global(song) == entry['before']['globalContext']
        if group is not None:
            key = f'track-{current.index(group)}'
            route = _track_routing(song, key, 0)['output']
            group_record = {**_track_record(song, group, current.index(group)), 'output': {k: route[k] for k in ('type', 'channel')}}
            routed = routed and route['type']['name'] == 'Main' and all(route['channel'] == t['output']['channel'] for t in entry['before']['targets'])
    except Exception as failure:
        error = error or str(failure)
    verified = not error and context and order and membership and other_parents and preserved and routed and controls and global_context
    unchanged = context and current == original and all(_parent(t) == p for t, p in zip(original, entry['parents'])) and preserved and controls and global_context and original_routing
    return {'stateVersion': version, 'groupingId': params['groupingId'], 'status': 'grouped' if verified else 'unchanged' if unchanged else 'changed',
            'group': group_record, 'members': members, 'renumberedGroupNames': renumbered,
            'originalOrderPreserved': bool(order), 'membershipVerified': bool(membership and other_parents),
            'materialPreserved': preserved, 'routingVerified': bool(routed), 'sourceOutputsPreserved': original_routing,
            'controlsPreserved': context and controls and global_context and bool(original_routing or group is not None and membership and routed),
            'groupVerified': bool(verified), 'inspectionRequired': not verified and not unchanged,
            **({'error': error} if error else {}),
            'limitation': 'Checks retained native tracks, exact membership and order, exposed target notes/timing/audio/device state and existing mixer/routing controls. Excludes automation envelopes, hidden plug-in state and external file bytes; does not establish audio equivalence or saved state. Track IDs shift after insertion. No automatic undo or ungrouping.'}
